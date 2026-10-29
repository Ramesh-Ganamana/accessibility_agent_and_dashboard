import json
import math
import os
import queue
import threading
import time
import urllib.request
from pathlib import Path

import api
import core
import queueHandler
import speech
from speech import sayAll
from speech.commands import IndexCommand
from speech.extensions import filter_speechSequence
import globalPluginHandler
import globalVars
import synthDriverHandler
import textInfos
import versionInfo
import winUser
from controlTypes import Role, State
from logHandler import log
from synthDriverHandler import pre_synthSpeak, synthDoneSpeaking, synthIndexReached

# Control acknowledgements are posted from NVDA's main thread; keep their
# worst-case block short. Transcripts are posted from the worker thread.
CONTROL_TYPES = {"ready", "scope-ready", "capture-ready", "capture-disarmed", "scope-stopped", "scope-paused"}
# The worker checks the control file this often (a cheap stat; the JSON is only
# parsed when the file changes) and flushes speech as soon as it is captured.
POLL_SECONDS = 0.05
# A title or accessibility-focus check can fail for one sample while a page
# updates. Consecutive failures at the 100 ms watch interval are a departure.
CONTEXT_FAILURE_LIMIT = 3
# Heartbeats renew the 45 s lease indefinitely, so a pause needs its own
# absolute bound. The controller sets one per pause; this caps it.
MAX_PAUSE_MS = 600000
AUDIO_QUIET_MS = 300
DEFAULT_SPEECH_RATE = 40


class GlobalPlugin(globalPluginHandler.GlobalPlugin):
    def __init__(self):
        super().__init__()
        self._stopped = threading.Event()
        self._queue = queue.Queue(maxsize=500)
        self._session = None
        self._announced_capture = None
        self._ready_capture = None
        self._announced_disarm = None
        self._last_command = None
        self._reading_command = None
        self._context_failures = 0
        self._speech_settings_applied = None
        self._speech_sequence = 0
        self._audio = None
        self._startup_complete = False
        self._startup_deadline_ms = None
        self._handoff_complete = False
        self._announced_scope = None
        self._ready_scope = None
        # Reversible, unlike _exit_requested: set while an opted-in controller
        # brings the test tab back after focus left it.
        self._paused = None
        self._pause_deadline_ms = None
        # Agent-owned readers remain quiet from startup until a test command is
        # armed, including after a crashed controller loses its control file.
        self._agent_owned = bool(os.environ.get("RAMBO_NVDA_RUN_ID"))
        self._had_session = False
        self._exit_requested = False
        self._control_path = Path(globalVars.appArgs.configPath) / "accessibilityAgentCapture.json"
        self._session = self._read_session()
        self._had_session = bool(self._session)
        self._agent_owned |= bool(self._session and self._session.get("agentOwnsReader"))
        self._update_check_disabled = False
        self._disable_update_check()
        pre_synthSpeak.register(self._on_speech)
        synthIndexReached.register(self._on_synth_index)
        synthDoneSpeaking.register(self._on_synth_done)
        filter_speechSequence.register(self._filter_speech)
        # Global plugins load before NVDA finishes synthesizer, document and
        # initial-focus setup. Only this official event authorizes readiness.
        try:
            core.postNvdaStartup.register(self._on_startup_complete)
        except Exception:
            log.debugWarning("RAMBO NVDA capture could not register startup readiness", exc_info=True)
            # Do not advertise readiness or enable speech if the required NVDA
            # lifecycle extension is unavailable on this installed version.
            core.callLater(100, lambda: self._stop_owned_reader("NVDA startup readiness hook is unavailable; NVDA is shutting down."))
        core.callLater(100, self._watch_scope)
        self._worker = threading.Thread(target=self._run, name="RAMBO-NVDA-Capture", daemon=True)
        self._worker.start()

    def terminate(self):
        self._stopped.set()
        self._cancel_reading()
        try:
            pre_synthSpeak.unregister(self._on_speech)
            synthIndexReached.unregister(self._on_synth_index)
            synthDoneSpeaking.unregister(self._on_synth_done)
            filter_speechSequence.unregister(self._filter_speech)
            core.postNvdaStartup.unregister(self._on_startup_complete)
        except Exception:
            pass
        super().terminate()

    def _scoped(self):
        return self._agent_owned or bool(self._session and self._session.get("speechScope") == "test-tab")

    def _on_startup_complete(self, **kwargs):
        if not self._stopped.is_set() and not self._exit_requested:
            self._startup_complete = True

    def _disable_update_check(self):
        # The dedicated agent test profile must not spend startup time or network
        # access on NVDA update checks. Only an agent-owned reader is changed; it
        # always runs with the separate RAMBO profile, never a personal profile.
        if not self._agent_owned or getattr(self, "_update_check_disabled", False):
            return
        try:
            import config
        except ImportError:
            self._update_check_disabled = True
            return
        try:
            if config.conf["update"]["autoCheck"]:
                config.conf["update"]["autoCheck"] = False
            self._update_check_disabled = True
        except Exception:
            log.debugWarning("RAMBO NVDA capture could not disable update checks in the test profile", exc_info=True)

    def _initializing(self):
        return (self._agent_owned and not self._handoff_complete
                and (self._session or {}).get("lifecycle") == "initializing")

    def _pausable(self):
        # Opt-in only (old controllers treat any loss as terminal), and never
        # for the first startup handoff, which keeps its stop-on-failure rule.
        return (self._agent_owned and not self._exit_requested and self._handoff_complete
                and (bool(getattr(self, "_paused", None)) or (self._session or {}).get("pauseResume") is True))

    def _pause_deadline(self):
        # Absolute and min-latched per pause like the startup deadline, so lease
        # heartbeats cannot extend it. A controller deadline is only read while
        # lifecycle is "paused": after a resume the file still holds the old one.
        session = self._session or {}
        deadline = getattr(self, "_pause_deadline_ms", None) or time.time() * 1000 + MAX_PAUSE_MS
        if session.get("lifecycle") == "paused" and session.get("pauseDeadlineMs", 0) > 0:
            deadline = min(deadline, session["pauseDeadlineMs"])
        self._pause_deadline_ms = deadline
        return deadline

    def _capture_lifecycle_ready(self):
        session = self._session or {}
        if not self._startup_complete or self._initializing() or getattr(self, "_paused", None):
            return False
        if self._agent_owned and session.get("lifecycle"):
            return (session.get("lifecycle") == "testing"
                    and self._ready_scope == (session.get("runId"), session.get("scopeId")))
        return True

    def _native_browser_scope(self):
        browser_scope = (self._session or {}).get("browserScope") or {}
        if not browser_scope.get("processId") or not browser_scope.get("windowHandle"):
            raise RuntimeError("The testing Chrome window is not identified.")
        native_handle = winUser.getForegroundWindow()
        native_pid, _ = winUser.getWindowThreadProcessID(native_handle)
        if native_pid != browser_scope["processId"] or native_handle != browser_scope["windowHandle"]:
            raise RuntimeError("Focus left the testing Chrome window.")
        return native_handle

    def _activate_scope(self, run_id, scope_id):
        session = self._session or {}
        if (self._exit_requested or not self._startup_complete
                or session.get("runId") != run_id or session.get("scopeId") != scope_id
                or session.get("lifecycle") != "testing" or not scope_id):
            return
        if (session.get("stopRequested")
                or session.get("expiresAtMs", 0) <= time.time() * 1000
                or (not self._handoff_complete and
                    (self._startup_deadline_ms or session.get("startupDeadlineMs", 0)) <= time.time() * 1000)):
            self._stop_owned_reader("NVDA startup handoff ended or expired; NVDA is shutting down.")
            return
        if getattr(self, "_paused", None) and self._pause_deadline() <= time.time() * 1000:
            self._stop_owned_reader("NVDA stayed paused past its deadline; NVDA is shutting down.")
            return
        try:
            native_handle = self._native_browser_scope()
            marker = (session.get("browserScope") or {}).get("titleMarker")
            if marker and marker.lower() not in str(winUser.getWindowText(native_handle) or "").lower():
                raise RuntimeError("The foreground tab is not the marked startup test tab.")
        except Exception as error:
            if self._pausable():
                # A later re-handoff is a resume attempt; the controller may
                # retry with another scopeId before the pause deadline.
                self._pause_owned_reader("resume rejected", scope_id, str(error))
                return
            self._stop_owned_reader(f"The testing Chrome scope was not ready ({error}); NVDA is shutting down.")
            return
        self._cancel_speech()
        self._apply_speech_settings("scope")
        self._ready_scope = (run_id, scope_id)
        self._handoff_complete = True
        self._paused = None
        self._pause_deadline_ms = None
        self._context_failures = 0
        self._post({"type": "scope-ready", "scopeId": scope_id, "initialized": True,
                    "speechSettings": self._speech_settings_snapshot()})

    def _test_context(self, full=False):
        if not self._capture_lifecycle_ready():
            raise RuntimeError("NVDA startup and testing scope are not ready.")
        capture = (self._session or {}).get("capture") or {}
        if not capture.get("active") or not capture.get("actionId"):
            raise RuntimeError("No test command is armed.")
        if self._scoped() and (self._session.get("expiresAtMs", 0) <= time.time() * 1000):
            raise RuntimeError("The test command's speech lease expired.")
        if self._scoped():
            native_handle = winUser.getForegroundWindow()
            native_pid, _ = winUser.getWindowThreadProcessID(native_handle)
            if native_handle != capture.get("windowHandle") or native_pid != capture.get("processId"):
                raise RuntimeError("The test browser is not the native foreground window.")
        foreground, focus = api.getForegroundObject(), api.getFocusObject()
        if not foreground or not focus or State.PROTECTED in focus.states:
            raise RuntimeError("Protected or unavailable focus.")
        if int(getattr(foreground, "processID", 0) or 0) != capture.get("processId"):
            raise RuntimeError("The test browser is not the foreground application.")
        marker = capture.get("titleMarker", "")
        # Title changes do not necessarily refresh NVDA's cached foreground
        # object's name. Read the real native title for tab attribution.
        native_title = winUser.getWindowText(native_handle) if self._scoped() else getattr(foreground, "name", "")
        if not marker or marker.lower() not in str(native_title or "").lower():
            raise RuntimeError("The foreground tab is not the marked test page.")
        handle = capture.get("windowHandle", 0)
        if self._scoped() and not handle:
            raise RuntimeError("The test browser window is not identified.")
        if handle and int(getattr(foreground, "windowHandle", 0) or 0) != int(handle):
            raise RuntimeError("The foreground browser window changed.")
        # Each parent hop is a cross-process call into the browser. Most checks
        # only need to know a document encloses focus; event filtering needs all.
        documents = self._document_chain(focus, first_only=not full)
        if not documents:
            raise RuntimeError(f"Focus is outside the website document (role={focus.role}, class={getattr(focus, 'windowClassName', '')}).")
        return capture, foreground, focus, documents

    @staticmethod
    def _document_chain(obj, first_only=False):
        documents = []
        for _ in range(64):
            if obj is None:
                break
            if obj.role == Role.DOCUMENT:
                documents.append(obj)
                if first_only:
                    break
            obj = obj.parent
        return documents

    def _filter_speech(self, speechSequence):
        # An empty sequence is filtered before speech reaches the viewer or
        # synthesizer. The observation hook alone cannot suppress desktop audio.
        if not self._scoped():
            return speechSequence
        if self._exit_requested or getattr(self, "_paused", None):
            return []
        try:
            self._test_context()
            return speechSequence
        except Exception:
            return []

    def _watch_scope(self):
        if self._stopped.is_set():
            return
        session = self._session or {}
        capture = session.get("capture") or {}
        if self._agent_owned and (session.get("stopRequested") or (self._had_session and not session)
                                  or (session and session.get("expiresAtMs", 0) <= time.time() * 1000)):
            self._stop_owned_reader("The test tab/session ended; NVDA is shutting down.")
            return
        browser_scope = session.get("browserScope") or {}
        if self._initializing():
            # NVDA's own Windows assistive-technology startup notification can
            # move foreground to Settings. Initialization stays completely
            # quiet until the controller returns to the verified Chrome tab.
            # This is an absolute startup allowance, never a renewable lease.
            deadline = session.get("startupDeadlineMs", 0)
            self._startup_deadline_ms = min(self._startup_deadline_ms or deadline, deadline)
            if self._startup_deadline_ms <= time.time() * 1000:
                self._stop_owned_reader("NVDA startup handoff timed out; NVDA is shutting down.")
                return
            core.callLater(100, self._watch_scope)
            return
        if getattr(self, "_paused", None) or (session.get("lifecycle") == "paused" and self._pausable()):
            if not getattr(self, "_paused", None):
                self._pause_owned_reader("The controller paused testing.")
            # Focus is expected to be elsewhere; only the deadline (and the
            # terminal checks above) end a pause.
            if self._pause_deadline() <= time.time() * 1000:
                self._stop_owned_reader("NVDA stayed paused past its deadline; NVDA is shutting down.")
                return
            core.callLater(100, self._watch_scope)
            return
        if self._agent_owned and browser_scope:
            try:
                # NVDA's foreground object is an event-driven cache. Check the
                # actual Windows foreground HWND/PID for process lifetime;
                # stale accessibility events must neither cause a false exit
                # nor leave the reader running after a real window switch.
                self._native_browser_scope()
            except Exception as error:
                if self._pausable():
                    self._pause_owned_reader("The testing Chrome window lost the foreground.", detail=str(error))
                    core.callLater(100, self._watch_scope)
                    return
                self._stop_owned_reader("The testing Chrome window is unavailable; NVDA is shutting down.")
                return
        if self._scoped():
            try:
                self._test_context()
                self._context_failures = 0
            except Exception as error:
                # Also interrupt speech already queued before a focus/tab change.
                # Speech stays filtered while the context is unavailable.
                self._cancel_speech()
                failures = getattr(self, "_context_failures", 0) + 1
                self._context_failures = failures
                if (capture.get("active") and capture.get("actionId") == self._ready_capture and self._agent_owned
                        and failures >= CONTEXT_FAILURE_LIMIT):
                    if self._pausable():
                        self._pause_owned_reader("The testing tab lost focus.", detail=str(error))
                        core.callLater(100, self._watch_scope)
                        return
                    self._stop_owned_reader(f"The testing tab context became unavailable ({error}); NVDA is shutting down.")
                    return
        core.callLater(100, self._watch_scope)

    def _stop_owned_reader(self, reason):
        if not self._agent_owned or self._exit_requested:
            return
        self._exit_requested = True
        log.info(reason)
        self._cancel_reading()
        self._cancel_speech()
        self._post({"type": "scope-stopped", "reason": reason})
        # Remove NVDA's desktop hooks by actually exiting the owned process.
        # The controller has a PID-specific fallback if a modal blocks exit.
        core.triggerNVDAExit()

    def _pause_owned_reader(self, reason, scope_id=None, detail=None):
        # Reversible sibling of _stop_owned_reader. Clearing _ready_scope mutes
        # speech and refuses capture and commands until a handoff with a NEW
        # scopeId succeeds (_announced_scope keeps the lost one from returning).
        if not self._agent_owned or self._exit_requested:
            return
        paused = getattr(self, "_paused", None)
        if paused is None:
            log.info(f"RAMBO NVDA paused: {reason}")
            self._cancel_reading()
            self._cancel_speech()
            lost = self._ready_scope or (None, (self._session or {}).get("scopeId"))
            self._ready_scope = None
            self._ready_capture = None
            self._announced_capture = None
            self._context_failures = 0
            self._pause_deadline_ms = None
            paused = self._paused = {"scopeId": lost[1], "reason": reason, "detail": detail, "armNotified": None}
        else:
            paused.update(reason=reason, detail=detail)
        if scope_id:
            paused["scopeId"] = scope_id
        self._post_pause(paused)

    def _post_pause(self, paused):
        payload = {"type": "scope-paused", "scopeId": paused.get("scopeId"), "reason": paused["reason"],
                   "deadlineMs": int(self._pause_deadline())}
        if paused.get("detail"):
            payload["detail"] = str(paused["detail"])[:500]
        self._post(payload)

    def _report_pause_to_arm(self, action_id):
        # A scope-paused POST can be lost (0.5 s timeout) or a brief flick can
        # escape the controller's own watch; answer its next arm instead of
        # leaving it to time out waiting for capture-ready.
        paused = getattr(self, "_paused", None)
        capture = (self._session or {}).get("capture") or {}
        if (not paused or self._exit_requested or paused.get("armNotified") == action_id
                or not capture.get("active") or capture.get("actionId") != action_id):
            return
        paused["armNotified"] = action_id
        self._post_pause(paused)

    def _activate_capture(self, run_id, action_id, deadline=None):
        session = self._session or {}
        capture = session.get("capture") or {}
        if (self._exit_requested or not self._capture_lifecycle_ready()
                or session.get("runId") != run_id or not capture.get("active") or capture.get("actionId") != action_id):
            return
        if self._scoped():
            self._cancel_speech()
            # CDP focus/title changes can precede NVDA's native accessibility
            # events. No command is authorized until NVDA sees this document.
            # Browser/window loss remains guarded throughout the handshake.
            deadline = deadline if deadline is not None else time.monotonic() + 2
            try:
                self._test_context()
            except Exception as error:
                if time.monotonic() < deadline:
                    core.callLater(100, lambda: self._activate_capture(run_id, action_id, deadline))
                elif self._pausable():
                    detail = str(error) or type(error).__name__
                    self._pause_owned_reader(f"The testing document did not become ready: {detail[:300]}", detail=detail)
                else:
                    self._stop_owned_reader(f"The testing document did not become ready ({error}); NVDA is shutting down.")
                return
        self._apply_speech_settings("capture")
        self._ready_capture = action_id
        # Idle ticks fail with "No test command is armed."; count departures
        # only from the arm, or the first failing tick would already stop.
        self._context_failures = 0
        # Acknowledge only after old queued speech is canceled on NVDA's thread.
        # Control acknowledgements must not sit behind a burst of speech
        # transcripts; the controller awaits them before changing page titles.
        self._post({"type": "capture-ready", "actionId": action_id})

    def _disarm_capture(self, run_id, disarm_id):
        session = self._session or {}
        if session.get("runId") != run_id or session.get("disarmId") != disarm_id or (session.get("capture") or {}).get("active"):
            return
        # Never gated on a pause: the controller needs this ack to pause at all.
        self._cancel_reading()
        self._cancel_speech()
        self._ready_capture = None
        self._context_failures = 0
        self._post({"type": "capture-disarmed", "disarmId": disarm_id})

    def _scoped_object_event(self, obj, nextHandler):
        if not self._scoped():
            nextHandler()
            return
        try:
            _, _, _, active_documents = self._test_context(full=True)
            source_documents = self._document_chain(obj)
            if any(source == active for source in source_documents for active in active_documents):
                nextHandler()
        except Exception:
            return

    def event_alert(self, obj, nextHandler):
        self._scoped_object_event(obj, nextHandler)

    def event_liveRegionChange(self, obj, nextHandler):
        self._scoped_object_event(obj, nextHandler)

    # Windows toast notifications use UIA events rather than event_alert.
    # Filter the event source before it queues speech; foreground focus alone
    # cannot distinguish a desktop toast from the page being read.
    def event_UIA_window_windowOpen(self, obj, nextHandler, **kwargs):
        self._scoped_object_event(obj, nextHandler)

    def event_UIA_toolTipOpened(self, obj, nextHandler, **kwargs):
        self._scoped_object_event(obj, nextHandler)

    def event_UIA_systemAlert(self, obj, nextHandler, **kwargs):
        self._scoped_object_event(obj, nextHandler)

    def event_UIA_notification(self, obj, nextHandler, **kwargs):
        self._scoped_object_event(obj, nextHandler)

    def _on_speech(self, speechSequence=None, **kwargs):
        if not speechSequence or not self._session:
            return
        try:
            capture, foreground, focus, _ = self._test_context()
            foreground_pid = int(getattr(foreground, "processID", 0) or 0)
            focus_pid = int(getattr(focus, "processID", 0) or 0)
            # The browser process also owns its toolbar. Classify by the focused
            # object's document ancestry, never by words such as "Close button"
            # which can be legitimate controls inside any website.
            focus_is_document = focus.role == Role.DOCUMENT
            is_focus_anchor = (str(getattr(focus, "name", "") or "") == "Accessibility test start"
                               and not capture.get("command"))
        except Exception:
            return
        # Focus/configuration profile switches can reload synthesizer settings
        # after the capture handshake. This hook runs on NVDA's main thread,
        # immediately before SynthDriver.speak(), so each utterance uses the
        # owned test reader's chosen runtime rate.
        self._apply_speech_settings()
        self._speech_sequence += 1
        sequence = self._speech_sequence
        synth = synthDriverHandler.getSynth()
        indexes = [item.index for item in speechSequence if isinstance(item, IndexCommand)]
        self._audio = {"runId": self._session.get("runId"), "actionId": capture.get("actionId"),
                       "speechSequence": sequence, "synth": synth,
                       "terminalIndex": indexes[-1] if indexes else None, "reached": False}
        text = " ".join(item for item in speechSequence if isinstance(item, str))
        text = " ".join(text.split()).strip()
        if not text:
            return
        if self._reading_command and self._reading_command["command"]["id"] == capture.get("actionId"):
            self._reading_command["speechSeen"] = True
            self._reading_command["audioFinished"] = False
        try:
            self._queue.put_nowait({
                "type": "speech",
                "actionId": capture.get("actionId"),
                "speechSequence": sequence,
                "text": text[:1000],
                "foregroundProcessId": foreground_pid,
                "focusProcessId": focus_pid,
                "inDocument": True,
                "focusIsDocument": focus_is_document,
                "isFocusAnchor": is_focus_anchor,
            })
        except queue.Full:
            pass

    def _cancel_speech(self):
        # A synthesizer can deliver a delayed completion after cancellation.
        # Invalidate its identity before canceling so it cannot finish a newer
        # command, including a command with the same action id.
        self._audio = None
        speech.cancelSpeech()

    def _on_synth_index(self, synth=None, index=None, **kwargs):
        audio = self._audio
        if audio is None or audio["synth"] is not synth or audio["terminalIndex"] != index:
            return
        queueHandler.queueFunction(queueHandler.eventQueue, self._mark_audio_index, audio)

    def _mark_audio_index(self, audio):
        if self._audio is audio:
            audio["reached"] = True

    def _on_synth_done(self, synth=None, **kwargs):
        # This public NVDA hook fires after the driver finishes audio playback.
        # The existing terminal index (assigned by NVDA's speech manager) ties
        # it to the current utterance; no additional indexes are injected.
        audio = self._audio
        if audio is None or audio["synth"] is not synth:
            return
        queueHandler.queueFunction(queueHandler.eventQueue, self._schedule_audio_idle, audio)

    def _schedule_audio_idle(self, audio):
        if self._audio is audio and audio["terminalIndex"] is not None and audio["reached"]:
            core.callLater(AUDIO_QUIET_MS, lambda: self._finish_audio_idle(audio))

    def _finish_audio_idle(self, audio):
        if (self._audio is not audio or self._stopped.is_set() or self._exit_requested
                or self._ready_capture != audio["actionId"]
                or (self._session or {}).get("runId") != audio["runId"]
                or synthDriverHandler.getSynth() is not audio["synth"]):
            return
        try:
            capture, _, _, _ = self._test_context()
            if capture.get("actionId") != audio["actionId"]:
                return
        except Exception:
            return
        try:
            # Share the transcript queue so an idle event cannot overtake its
            # speech event at the receiver. The next utterance invalidates this
            # generation during the quiet window.
            self._queue.put_nowait({"type": "speech-idle", "actionId": audio["actionId"],
                                    "speechSequence": audio["speechSequence"], "audibleComplete": True,
                                    "speechSettings": self._speech_settings_snapshot()})
            if self._reading_command and self._reading_command["command"]["id"] == audio["actionId"]:
                self._reading_command["audioFinished"] = True
            self._audio = None
        except queue.Full:
            pass

    def _run(self):
        announced_run = None
        last_signature = None
        next_full_read = 0.0
        while not self._stopped.is_set():
            try:
                stat = self._control_path.stat()
                signature = (stat.st_mtime_ns, stat.st_size)
            except OSError:
                signature = None
            # Parse only when the controller rewrote the file (or once a second),
            # then flush captured speech without waiting for the next tick.
            startup_ready = (self._startup_complete
                             and announced_run != (self._session or {}).get("runId"))
            if signature != last_signature or time.monotonic() >= next_full_read or startup_ready:
                last_signature = signature
                next_full_read = time.monotonic() + 1.0
                announced_run = self._process_session(announced_run)
            self._flush(POLL_SECONDS)

    def _flush(self, timeout):
        try:
            payload = self._queue.get(timeout=timeout)
        except queue.Empty:
            return
        self._post(payload)
        while not self._stopped.is_set():
            try:
                payload = self._queue.get_nowait()
            except queue.Empty:
                break
            self._post(payload)

    def _process_session(self, announced_run):
        session = self._read_session()
        if not session:
            self._session = None
            return None
        self._session = session
        self._had_session = True
        # Windows UIAccess relaunch can discard the launcher's environment.
        # The exclusive controller therefore also conveys ownership through
        # its dedicated, authenticated test-profile control session.
        self._agent_owned |= session.get("agentOwnsReader") is True
        if self._agent_owned and not getattr(self, "_update_check_disabled", False):
            # NVDA configuration may only be changed on its main thread.
            queueHandler.queueFunction(queueHandler.eventQueue, self._disable_update_check)
        if self._initializing():
            deadline = session.get("startupDeadlineMs", 0)
            self._startup_deadline_ms = min(self._startup_deadline_ms or deadline, deadline)
        if self._startup_complete and self._agent_owned:
            # Check live values on NVDA's thread even when the desired values
            # did not change; a profile switch can reset an existing driver.
            queueHandler.queueFunction(queueHandler.eventQueue, self._apply_speech_settings)
        if (self._startup_complete and not self._exit_requested
                and not session.get("stopRequested")
                and (not self._scoped() or session.get("expiresAtMs", 0) > time.time() * 1000)
                and (not self._initializing() or self._startup_deadline_ms > time.time() * 1000)
                and announced_run != session.get("runId")):
            if self._post({"type": "ready", "initialized": True, "version": versionInfo.version, "protocolVersion": 6, "speechScope": session.get("speechScope"), "readerProcessId": os.getpid(), "agentOwnsReader": self._agent_owned, "capabilities": ["fast-speech", "speech-settings", "audible-completion", "reading-completion", "immediate-flush", "startup-handoff", "scope-pause"]}):
                announced_run = session.get("runId")
        scope_key = (session.get("runId"), session.get("scopeId"))
        if (self._agent_owned and self._startup_complete and session.get("lifecycle") == "testing"
                and session.get("scopeId") and scope_key != self._announced_scope):
            self._announced_scope = scope_key
            queueHandler.queueFunction(queueHandler.eventQueue, self._activate_scope, *scope_key)
        capture = session.get("capture") or {}
        capture_id = capture.get("actionId") if capture.get("active") and self._capture_lifecycle_ready() else None
        paused = getattr(self, "_paused", None)
        if paused and capture.get("active") and capture.get("actionId") and capture.get("actionId") != paused.get("armNotified"):
            queueHandler.queueFunction(queueHandler.eventQueue, self._report_pause_to_arm, capture.get("actionId"))
        if capture_id and capture_id != self._announced_capture:
            self._announced_capture = capture_id
            queueHandler.queueFunction(queueHandler.eventQueue, self._activate_capture, session.get("runId"), capture_id)
        elif not capture_id:
            self._announced_capture = None
            disarm_id = session.get("disarmId")
            if disarm_id and disarm_id != self._announced_disarm:
                self._announced_disarm = disarm_id
                queueHandler.queueFunction(queueHandler.eventQueue, self._disarm_capture, session.get("runId"), disarm_id)
        command = capture.get("command") or {}
        command_key = (session.get("runId"), command.get("id"))
        if capture_id and command.get("id") == capture_id and command_key != self._last_command:
            self._last_command = command_key
            # NVDA objects and scripts must only be accessed on NVDA's main thread.
            queueHandler.queueFunction(queueHandler.eventQueue, self._execute_command, command, session.get("runId"))
        if self._reading_command and not capture_id:
            queueHandler.queueFunction(queueHandler.eventQueue, self._cancel_reading)
        return announced_run

    @staticmethod
    def _bounded_speech_rate(value):
        try:
            numeric = float(value) if not isinstance(value, bool) else float("nan")
            return max(0, min(100, int(numeric))) if math.isfinite(numeric) else DEFAULT_SPEECH_RATE
        except (TypeError, ValueError, OverflowError):
            return DEFAULT_SPEECH_RATE

    @staticmethod
    def _speech_settings_snapshot():
        # Report the driver's actual runtime values, never echo configured
        # targets when a setting was unsupported or could not be read.
        settings = {"rate": None, "rateBoost": None}
        try:
            synth = synthDriverHandler.getSynth()
        except Exception:
            return settings
        if synth is None:
            return settings
        try:
            if synth.isSupported("rate"):
                rate = synth.rate
                if (isinstance(rate, (int, float)) and not isinstance(rate, bool)
                        and math.isfinite(rate) and 0 <= rate <= 100):
                    settings["rate"] = rate
        except Exception:
            pass
        try:
            if synth.isSupported("rateBoost"):
                boost = synth.rateBoost
                if isinstance(boost, bool):
                    settings["rateBoost"] = boost
        except Exception:
            pass
        return settings

    def _apply_speech_settings(self, diagnostic_stage=None):
        # Use a comfortable voice in the owned test reader. Fast speech is an
        # explicit opt-in. Never persist these changes or alter a personal NVDA.
        if not self._agent_owned or self._exit_requested:
            return
        session = self._session or {}
        rate = self._bounded_speech_rate(session.get("speechRate"))
        fast = session.get("fastSpeech") is True
        try:
            synth = synthDriverHandler.getSynth()
            if not synth:
                return
            supports_boost = synth.isSupported("rateBoost")
            supports_rate = synth.isSupported("rate")
            actual = self._speech_settings_snapshot()
            applied = self._speech_settings_applied
            target_rate = 100 if fast else rate
            if (applied and applied[0:2] == (rate, fast) and applied[2] is synth
                    and (not supports_rate or actual["rate"] == target_rate)
                    and (not supports_boost or actual["rateBoost"] is fast)):
                return
            if supports_boost:
                synth.rateBoost = fast
            if supports_rate:
                synth.rate = target_rate
            self._speech_settings_applied = (rate, fast, synth)
            if diagnostic_stage in {"scope", "capture"}:
                actual = self._speech_settings_snapshot()
                if ((supports_rate and actual["rate"] != target_rate)
                        or (supports_boost and actual["rateBoost"] is not fast)):
                    # Only runtime synth numbers/flags appear in this diagnostic;
                    # never document content, input values or profile contents.
                    log.info(f"RAMBO NVDA speech settings pending at {diagnostic_stage}: "
                             f"requested rate={target_rate}, rateBoost={fast}; "
                             f"actual rate={actual['rate']}, rateBoost={actual['rateBoost']}.")
        except Exception:
            log.debugWarning("RAMBO NVDA capture could not apply the test speech settings", exc_info=True)

    def _read_session(self):
        try:
            data = json.loads(self._control_path.read_text(encoding="utf-8"))
            endpoint = str(data.get("endpoint", ""))
            token = str(data.get("token", ""))
            run_id = str(data.get("runId", ""))
            if not endpoint.startswith("http://127.0.0.1:") or not token or not run_id:
                return None
            raw_capture = data.get("capture") if isinstance(data.get("capture"), dict) else {}
            raw_browser = data.get("browserScope") if isinstance(data.get("browserScope"), dict) else {}
            startup_deadline = float(data.get("startupDeadlineMs", 0))
            expires_at = float(data.get("expiresAtMs", 0))
            if not math.isfinite(startup_deadline) or not math.isfinite(expires_at):
                return None
            # Optional: a controller may clear it with null. Anything that is not
            # a finite number is ignored and the add-on's own cap applies.
            raw_pause = data.get("pauseDeadlineMs")
            pause_deadline = float(raw_pause) if isinstance(raw_pause, (int, float)) and not isinstance(raw_pause, bool) else 0.0
            pause_deadline = pause_deadline if math.isfinite(pause_deadline) and pause_deadline > 0 else 0.0
            browser_scope = {"processId": int(raw_browser.get("processId", 0)), "windowHandle": int(raw_browser.get("windowHandle", 0)),
                             "titleMarker": str(raw_browser.get("titleMarker", ""))[:200]} if raw_browser else None
            capture = {
                "active": bool(raw_capture.get("active")),
                "actionId": str(raw_capture.get("actionId", ""))[:100],
                "processId": int(raw_capture.get("processId", 0) or 0),
                "windowHandle": int(raw_capture.get("windowHandle", 0) or 0),
                "titleMarker": str(raw_capture.get("titleMarker", ""))[:200],
            }
            raw_command = raw_capture.get("command")
            if isinstance(raw_command, dict) and raw_command.get("kind") in {
                "say-all", "next-heading", "next-table", "next-column", "next-row"
            }:
                capture["command"] = {
                    "id": str(raw_command.get("id", ""))[:100],
                    "kind": raw_command["kind"],
                    "resetPosition": bool(raw_command.get("resetPosition")),
                    "maxDurationMs": max(100, min(1800000 if raw_command["kind"] == "say-all" else 30000, int(raw_command.get("maxDurationMs", 1500)))),
                }
            return {"endpoint": endpoint, "token": token, "runId": run_id, "capture": capture,
                    "stopRequested": data.get("stopRequested") is True,
                    "agentOwnsReader": data.get("agentOwnsReader") is True,
                    "fastSpeech": data.get("fastSpeech") is True,
                    "speechRate": self._bounded_speech_rate(data.get("speechRate")),
                    "browserScope": browser_scope,
                    "lifecycle": str(data.get("lifecycle", ""))[:30],
                    "scopeId": str(data.get("scopeId", ""))[:100],
                    "startupDeadlineMs": min(startup_deadline, time.time() * 1000 + 310000),
                    "disarmId": str(data.get("disarmId", ""))[:100],
                    "speechScope": "test-tab" if data.get("speechScope") == "test-tab" else None,
                    "pauseResume": data.get("pauseResume") is True,
                    "pauseDeadlineMs": min(pause_deadline, time.time() * 1000 + MAX_PAUSE_MS) if pause_deadline else 0,
                    "expiresAtMs": min(expires_at, time.time() * 1000 + 45000)}
        except Exception:
            return None

    def _guard_command(self, command, run_id):
        if self._exit_requested:
            raise RuntimeError("NVDA is shutting down; no further command was executed.")
        if getattr(self, "_paused", None):
            raise RuntimeError("NVDA testing is paused; no command was executed.")
        session = self._session or {}
        capture = session.get("capture") or {}
        if session.get("runId") != run_id or not capture.get("active") or capture.get("actionId") != command.get("id"):
            raise RuntimeError("The requested capture window is no longer active.")
        return self._test_context()[2]

    def _command_result(self, command, status, reason="", **details):
        try:
            self._queue.put_nowait({"type": "command-result", "commandId": command["id"],
                                    "kind": command["kind"], "status": status, "reason": reason, **details})
        except queue.Full:
            pass

    def _execute_command(self, command, run_id, focus_attempt=0):
        try:
            focus = self._guard_command(command, run_id)
            interceptor = getattr(focus, "treeInterceptor", None)
            if not interceptor or getattr(interceptor, "passThrough", True):
                self._command_result(command, "skipped", "Browse mode is not available at this focus position; no keys were typed.")
                return
            self._cancel_reading()
            self._cancel_speech()
            if command.get("resetPosition"):
                # Start from the injected focus anchor, including an open modal's
                # anchor. Never move the application's text-input caret.
                try:
                    position = interceptor.makeTextInfo(focus)
                    position.collapse()
                    interceptor.selection = position
                except LookupError:
                    # A newly opened dialog's native focus can arrive before
                    # Chromium's virtual buffer contains the injected anchor.
                    # Retry only positioning, with fresh scope guards every
                    # time. Never substitute another document or type keys.
                    if focus_attempt < 20:
                        core.callLater(100, lambda: self._execute_command(command, run_id, focus_attempt + 1))
                        return
                    raise RuntimeError("NVDA's browse buffer could not locate the current state's focus anchor after 2 seconds; this state was not read.")
            if command["kind"] == "say-all":
                self._reading_command = {"command": command, "runId": run_id, "started": time.monotonic(),
                                         "interceptor": interceptor, "speechSeen": False, "audioFinished": False}
                sayAll.SayAllHandler.readText(sayAll.CURSOR.CARET)
                core.callLater(100, self._watch_reading)
                return
            method = {"next-heading": "script_nextHeading", "next-table": "script_nextTable",
                      "next-column": "script_nextColumn", "next-row": "script_nextRow"}.get(command["kind"])
            script = getattr(interceptor, method or "", None)
            if not callable(script):
                self._command_result(command, "skipped", "This document does not expose the requested NVDA navigation script.")
                return
            # Invoke NVDA's real browse script, not printable H/T in the webpage.
            script(None)
            self._command_result(command, "executed", "NVDA navigation script executed; its announcement requires review.")
        except Exception as error:
            log.debugWarning("RAMBO NVDA browse command failed", exc_info=True)
            self._command_result(command, "blocked", (str(error) or type(error).__name__)[:500])

    def _watch_reading(self):
        active = self._reading_command
        if not active:
            return
        command, run_id, started = active["command"], active["runId"], active["started"]
        try:
            focus = self._guard_command(command, run_id)
            if getattr(focus, "treeInterceptor", None) is not active["interceptor"]:
                raise RuntimeError("The browse document changed during reading.")
            timed_out = (time.monotonic() - started) * 1000 >= command["maxDurationMs"]
            running = sayAll.SayAllHandler.isRunning()
            # A stopped reader alone is not proof of completion: it can be
            # interrupted or still have buffered audio. Require a matching
            # driver completion AND a caret at the final browse reading chunk.
            if not running and active["speechSeen"] and active["audioFinished"] and self._audio is None:
                at_end = self._reading_at_end(active["interceptor"])
                self._reading_command = None  # Do not cancel the final spoken words.
                self._command_result(command, "executed" if at_end else "partial",
                                     "Available browse content reached its end and speech finished; this is not whole-site or usability coverage." if at_end
                                     else "Speech stopped before the end of available browse content could be confirmed; review or retry this state.",
                                     readingCompletion="completed" if at_end else "unconfirmed", audibleComplete=True)
                return
            if timed_out:
                self._cancel_reading()
                self._command_result(command, "partial", "Reading reached its safety timeout before end-of-content and audible completion were confirmed. Increase NVDA_READING_TIMEOUT_MS or review this state manually.",
                                     readingCompletion="timed-out", audibleComplete=False)
                return
        except Exception as error:
            self._cancel_reading()
            self._command_result(command, "blocked", str(error)[:500], readingCompletion="interrupted", audibleComplete=False)
            return
        core.callLater(100, self._watch_reading)

    @staticmethod
    def _reading_at_end(interceptor):
        try:
            # Say All updates the caret to the start of the last spoken chunk.
            # Expanding a copy checks its end without moving the user's caret.
            position = interceptor.selection.copy()
            position.expand(textInfos.UNIT_READINGCHUNK)
            end = interceptor.makeTextInfo(textInfos.POSITION_LAST)
            return position.compareEndPoints(end, "endToEnd") >= 0
        except Exception:
            return False

    def _cancel_reading(self):
        if self._reading_command:
            self._reading_command = None
            sayAll.SayAllHandler.stop()
            self._cancel_speech()

    def _post(self, payload):
        session = self._session
        if not session:
            return False
        try:
            request = urllib.request.Request(
                session["endpoint"],
                data=json.dumps(payload).encode("utf-8"),
                headers={"Content-Type": "application/json", "X-RAMBO-Token": session["token"]},
                method="POST",
            )
            timeout = 0.5 if payload.get("type") in CONTROL_TYPES else 1.5
            with urllib.request.urlopen(request, timeout=timeout) as response:
                return 200 <= response.status < 300
        except Exception:
            log.debugWarning("RAMBO NVDA capture could not reach the local receiver", exc_info=True)
            return False
