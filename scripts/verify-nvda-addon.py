"""Exercise source attribution without launching or depending on installed NVDA."""
import importlib.util
import queue
import sys
import types
import unittest
import time
from pathlib import Path
from unittest.mock import patch

api = types.SimpleNamespace()
sys.modules["api"] = api
win_user = types.SimpleNamespace()
sys.modules["winUser"] = win_user
class PluginBase:
    def terminate(self):
        pass

class Hook:
    def __init__(self):
        self.handlers = []
    def register(self, fn):
        self.handlers.append(fn)
    def unregister(self, fn):
        self.handlers.remove(fn)

sys.modules["globalPluginHandler"] = types.SimpleNamespace(GlobalPlugin=PluginBase)
sys.modules["globalVars"] = types.SimpleNamespace()
sys.modules["versionInfo"] = types.SimpleNamespace(version="fixture")
sys.modules["controlTypes"] = types.SimpleNamespace(
    Role=types.SimpleNamespace(DOCUMENT="document"),
    State=types.SimpleNamespace(PROTECTED="protected"),
)
sys.modules["logHandler"] = types.SimpleNamespace(log=types.SimpleNamespace(info=lambda message: None,
                                                                           debugWarning=lambda *args, **kwargs: None))
observation_hook = Hook()
speech_filter = Hook()
audio_done_hook = Hook()
audio_index_hook = Hook()
synth = types.SimpleNamespace(rate=100, rateBoost=True, isSupported=lambda key: key in {"rate", "rateBoost"})
saved_synth_settings = []
synth.saveSettings = lambda: saved_synth_settings.append(True)
sys.modules["synthDriverHandler"] = types.SimpleNamespace(pre_synthSpeak=observation_hook,
    synthDoneSpeaking=audio_done_hook, synthIndexReached=audio_index_hook, getSynth=lambda: synth)
sys.modules["speech.extensions"] = types.SimpleNamespace(filter_speechSequence=speech_filter)
class IndexCommand:
    def __init__(self, index):
        self.index = index

sys.modules["speech.commands"] = types.SimpleNamespace(IndexCommand=IndexCommand)
sys.modules["textInfos"] = types.SimpleNamespace(UNIT_READINGCHUNK="readingChunk", POSITION_LAST="last")
scheduled = []
exits = []
startup_hook = Hook()
sys.modules["core"] = types.SimpleNamespace(callLater=lambda delay, callback: scheduled.append(callback),
                                           triggerNVDAExit=lambda: exits.append(True), postNvdaStartup=startup_hook)
sys.modules["queueHandler"] = types.SimpleNamespace(eventQueue=object(), queueFunction=lambda _queue, fn, *args: fn(*args))
say_all = types.SimpleNamespace(CURSOR=types.SimpleNamespace(CARET=0),
                                SayAllHandler=types.SimpleNamespace(readText=lambda cursor: None, stop=lambda: None, isRunning=lambda: False))
cancellations = []
sys.modules["speech"] = types.SimpleNamespace(cancelSpeech=lambda: cancellations.append(True), sayAll=say_all)
source = Path(__file__).resolve().parents[1] / "nvda-addon/accessibilityAgentCapture/globalPlugins/accessibilityAgentCapture.py"
spec = importlib.util.spec_from_file_location("capture_fixture", source)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


def node(role="button", name="Close", parent=None, pid=43, protected=False, handle=420):
    return types.SimpleNamespace(role=role, name=name, parent=parent, processID=pid,
                                 windowHandle=handle, states={"protected"} if protected else set())


class CaptureTests(unittest.TestCase):
    def setUp(self):
        self.plugin = module.GlobalPlugin.__new__(module.GlobalPlugin)
        self.plugin._queue = queue.Queue()
        self.plugin._reading_command = None
        self.plugin._agent_owned = False
        self.plugin._had_session = True
        self.plugin._exit_requested = False
        self.plugin._startup_complete = True
        self.plugin._startup_deadline_ms = None
        self.plugin._handoff_complete = False
        self.plugin._announced_scope = None
        self.plugin._ready_scope = None
        self.plugin._paused = None
        self.plugin._pause_deadline_ms = None
        self.plugin._announced_capture = None
        self.plugin._announced_disarm = None
        self.plugin._last_command = None
        self.plugin._speech_settings_applied = None
        self.plugin._speech_sequence = 0
        self.plugin._audio = None
        self.plugin._stopped = types.SimpleNamespace(is_set=lambda: False)
        self.plugin._ready_capture = "action-1"
        self.posted = []
        self.plugin._post = lambda payload: self.posted.append(payload) or True
        self.plugin._session = {"runId": "run-1", "speechScope": "test-tab", "expiresAtMs": time.time() * 1000 + 45000,
                                "capture": {"active": True, "actionId": "action-1",
                                            "processId": 42, "windowHandle": 420, "titleMarker": "fixture-window"}}
        self.document = node(role="document", name="Fixture")
        self.foreground = node(name="fixture-window - Chromium", pid=42)
        self.focus = node(parent=self.document)
        api.getForegroundObject = lambda: self.foreground
        api.getFocusObject = lambda: self.focus
        win_user.getForegroundWindow = lambda: self.foreground.windowHandle
        win_user.getWindowThreadProcessID = lambda handle: (self.foreground.processID, 1)
        win_user.getWindowText = lambda handle: self.foreground.name
        scheduled.clear()
        cancellations.clear()
        exits.clear()
        synth.rate = 100
        synth.rateBoost = True
        saved_synth_settings.clear()

    def initialize_session(self):
        self.plugin._agent_owned = True
        self.plugin._startup_complete = False
        self.plugin._session.update(lifecycle="initializing", scopeId="scope-1", agentOwnsReader=True,
                                    startupDeadlineMs=time.time() * 1000 + 60000,
                                    browserScope={"processId": 42, "windowHandle": 420,
                                                  "titleMarker": "fixture-window"})
        self.plugin._session["capture"]["active"] = False
        self.plugin._read_session = lambda: self.plugin._session

    def test_constructor_registers_official_startup_hook_before_announcing_ready(self):
        self.initialize_session()
        session = self.plugin._session
        worker = types.SimpleNamespace(start=lambda: None)
        sys.modules["globalVars"].appArgs = types.SimpleNamespace(configPath=".")
        startup_hook.handlers.clear()
        with patch.object(module.GlobalPlugin, "_read_session", return_value=session), \
                patch.object(module.threading, "Thread", return_value=worker):
            instance = module.GlobalPlugin()
        try:
            instance._read_session = lambda: session
            self.assertIn(instance._on_startup_complete, startup_hook.handlers)
            self.assertIn(instance._on_synth_done, audio_done_hook.handlers)
            self.assertIn(instance._on_synth_index, audio_index_hook.handlers)
            self.assertFalse(instance._startup_complete)
            instance._post = lambda payload: self.posted.append(payload) or True
            self.assertIsNone(instance._process_session(None))
            self.assertEqual(self.posted, [])
            for handler in tuple(startup_hook.handlers):
                handler()
            self.assertTrue(instance._startup_complete)
            self.assertEqual(instance._process_session(None), "run-1")
            self.assertEqual(self.posted[0]["type"], "ready")
            self.assertTrue(self.posted[0]["initialized"])
            self.assertEqual(self.posted[0]["protocolVersion"], 6)
            self.assertIn("startup-handoff", self.posted[0]["capabilities"])
            self.assertIn("audible-completion", self.posted[0]["capabilities"])
            self.assertIn("scope-pause", self.posted[0]["capabilities"])
            self.assertIsNone(instance._paused)
            self.assertEqual(synth.rate, 40)
            self.assertFalse(synth.rateBoost)
        finally:
            instance.terminate()
        self.assertNotIn(instance._on_startup_complete, startup_hook.handlers)
        self.assertNotIn(instance._on_synth_done, audio_done_hook.handlers)
        self.assertNotIn(instance._on_synth_index, audio_index_hook.handlers)

    def test_owned_reader_defaults_to_comfortable_runtime_speech_without_boost(self):
        self.plugin._agent_owned = True
        self.plugin._apply_speech_settings()
        self.assertEqual(synth.rate, 40)
        self.assertFalse(synth.rateBoost)
        self.assertEqual(self.plugin._speech_settings_applied[0:2], (40, False))
        self.assertIs(self.plugin._speech_settings_applied[2], synth)
        self.plugin._session.update(speechRate=25)
        self.plugin._apply_speech_settings()
        self.assertEqual(synth.rate, 25)

    def test_fast_speech_requires_explicit_true_and_does_not_change_personal_reader(self):
        self.plugin._session.update(fastSpeech=True, speechRate=40)
        synth.rate = 25
        synth.rateBoost = False
        self.plugin._apply_speech_settings()
        self.assertEqual(synth.rate, 25)
        self.assertFalse(synth.rateBoost)
        self.plugin._agent_owned = True
        self.plugin._apply_speech_settings()
        self.assertEqual(synth.rate, 100)
        self.assertTrue(synth.rateBoost)
        self.plugin._session.update(fastSpeech="true")
        self.plugin._apply_speech_settings()
        self.assertEqual(synth.rate, 40)
        self.assertFalse(synth.rateBoost)

    def test_speech_rate_is_bounded_and_invalid_values_default_to_40(self):
        import json
        for value, expected in [(None, 40), (False, 40), (True, 40), ("invalid", 40),
                                (float("nan"), 40), (float("inf"), 40), (-1, 0), (101, 100), (25, 25)]:
            with self.subTest(value=value):
                self.assertEqual(self.plugin._bounded_speech_rate(value), expected)
                payload = json.dumps({"endpoint": "http://127.0.0.1:4000", "token": "secret", "runId": "run-1",
                                      "speechRate": value, "fastSpeech": False})
                self.plugin._control_path = types.SimpleNamespace(read_text=lambda **kwargs: payload)
                self.assertEqual(self.plugin._read_session()["speechRate"], expected)

    def utterance(self, index=12):
        self.plugin._on_speech(speechSequence=["Readable website announcement", IndexCommand(index)])
        return self.plugin._queue.get_nowait()

    def test_audio_idle_requires_matching_final_index_done_and_quiet_window(self):
        event = self.utterance()
        self.assertEqual(event["speechSequence"], 1)
        self.plugin._on_synth_done(synth=synth)
        self.assertEqual(scheduled, [], "A stale done callback cannot prove the new utterance finished")
        self.plugin._on_synth_index(synth=synth, index=11)
        self.plugin._on_synth_done(synth=synth)
        self.assertEqual(scheduled, [])
        self.plugin._on_synth_index(synth=synth, index=12)
        self.assertEqual(scheduled, [], "The terminal index alone does not prove output is finished")
        self.plugin._on_synth_done(synth=synth)
        self.assertTrue(self.plugin._queue.empty())
        self.assertEqual(len(scheduled), 1)
        scheduled.pop()()
        self.assertEqual(self.plugin._queue.get_nowait(), {"type": "speech-idle", "actionId": "action-1",
                         "speechSequence": 1, "audibleComplete": True,
                         "speechSettings": {"rate": 100, "rateBoost": True}})

    def test_foreign_synth_or_missing_index_cannot_prove_audible_completion(self):
        self.utterance()
        other_synth = types.SimpleNamespace()
        self.plugin._on_synth_index(synth=other_synth, index=12)
        self.plugin._on_synth_done(synth=other_synth)
        self.assertEqual(scheduled, [])
        self.plugin._on_speech(speechSequence=["Announcement without a manager index"])
        self.plugin._queue.get_nowait()
        self.plugin._on_synth_done(synth=synth)
        self.assertEqual(scheduled, [])

    def test_next_utterance_invalidates_previous_idle_during_quiet_window(self):
        first = self.utterance(12)
        self.plugin._on_synth_index(synth=synth, index=12)
        self.plugin._on_synth_done(synth=synth)
        second = self.utterance(13)
        self.assertGreater(second["speechSequence"], first["speechSequence"])
        scheduled.pop()()
        self.assertTrue(self.plugin._queue.empty())
        self.plugin._on_synth_index(synth=synth, index=12)
        self.plugin._on_synth_done(synth=synth)
        self.assertEqual(scheduled, [], "Old terminal index must not finish the next utterance")
        self.plugin._on_synth_index(synth=synth, index=13)
        self.plugin._on_synth_done(synth=synth)
        scheduled.pop()()
        self.assertEqual(self.plugin._queue.get_nowait()["speechSequence"], 2)

    def test_cancel_disarm_stop_and_foreign_scope_discard_pending_audio_idle(self):
        changes = [lambda: self.plugin._cancel_speech(),
                   lambda: self.plugin._session["capture"].update(active=False),
                   lambda: self.plugin._session["capture"].update(actionId="other-command"),
                   lambda: self.plugin._session.update(runId="other-run"),
                   lambda: setattr(self.foreground, "name", "Other browser tab"),
                   lambda: setattr(self.foreground, "processID", 100),
                   lambda: self.focus.states.add("protected"),
                   lambda: setattr(self.plugin, "_exit_requested", True),
                   lambda: setattr(self.plugin, "_paused", {"scopeId": "scope-1", "reason": "Fixture pause"})]
        for change in changes:
            self.setUp()
            self.utterance()
            self.plugin._on_synth_index(synth=synth, index=12)
            self.plugin._on_synth_done(synth=synth)
            change()
            scheduled.pop()()
            self.assertTrue(self.plugin._queue.empty())

    def test_canceling_old_audio_never_finishes_rearmed_action_with_same_id(self):
        self.utterance(12)
        self.plugin._on_synth_index(synth=synth, index=12)
        self.plugin._on_synth_done(synth=synth)
        self.plugin._activate_capture("run-1", "action-1")
        self.utterance(13)
        scheduled.pop()()
        self.assertTrue(self.plugin._queue.empty())
        self.plugin._on_synth_index(synth=synth, index=12)
        self.plugin._on_synth_done(synth=synth)
        self.assertEqual(scheduled, [])

    def test_synth_change_invalidates_previous_audio_idle(self):
        self.utterance()
        self.plugin._on_synth_index(synth=synth, index=12)
        self.plugin._on_synth_done(synth=synth)
        with patch.object(module.synthDriverHandler, "getSynth", return_value=types.SimpleNamespace()):
            scheduled.pop()()
        self.assertTrue(self.plugin._queue.empty())

    def test_speech_settings_wait_for_official_startup_and_never_save_config(self):
        self.initialize_session()
        self.plugin._process_session(None)
        self.assertEqual(synth.rate, 100)
        self.assertTrue(synth.rateBoost)
        self.plugin._on_startup_complete()
        self.plugin._process_session(None)
        self.assertEqual(synth.rate, 40)
        self.assertFalse(synth.rateBoost)
        self.assertEqual(saved_synth_settings, [])

    def test_speech_settings_snapshot_reads_actual_driver_instead_of_configured_targets(self):
        self.plugin._session.update(speechRate=40, fastSpeech=False)
        synth.rate = 25
        synth.rateBoost = True
        self.assertEqual(self.plugin._speech_settings_snapshot(), {"rate": 25, "rateBoost": True})

    def test_speech_settings_snapshot_reports_unknown_for_unsupported_invalid_or_unavailable_values(self):
        invalid = types.SimpleNamespace(rate=float("inf"), rateBoost="false", isSupported=lambda key: True)
        unsupported = types.SimpleNamespace(rate=40, rateBoost=False, isSupported=lambda key: False)
        for driver in (None, invalid, unsupported):
            with patch.object(module.synthDriverHandler, "getSynth", return_value=driver):
                self.assertEqual(self.plugin._speech_settings_snapshot(), {"rate": None, "rateBoost": None})
        with patch.object(module.synthDriverHandler, "getSynth", side_effect=RuntimeError("Driver unavailable")):
            self.assertEqual(self.plugin._speech_settings_snapshot(), {"rate": None, "rateBoost": None})

    def test_scope_and_capture_ack_restore_rate_after_focus_profile_reload(self):
        self.initialize_session()
        self.plugin._on_startup_complete()
        self.plugin._process_session(None)
        self.assertEqual(synth.rate, 40)
        # Simulate OneCore loading the profile again as Chrome takes focus.
        synth.rate = 50
        synth.rateBoost = True
        self.plugin._session.update(lifecycle="testing")
        self.plugin._activate_scope("run-1", "scope-1")
        self.assertEqual(self.posted[-1]["type"], "scope-ready")
        self.assertEqual(self.posted[-1]["speechSettings"], {"rate": 40, "rateBoost": False})
        synth.rate = 50
        synth.rateBoost = True
        self.plugin._session["capture"].update(active=True)
        self.plugin._activate_capture("run-1", "action-1")
        self.assertEqual(self.posted[-1]["type"], "capture-ready")
        self.assertEqual(self.plugin._speech_settings_snapshot(), {"rate": 40, "rateBoost": False})
        self.assertEqual(saved_synth_settings, [])

    def test_control_poll_repairs_live_values_even_when_desired_settings_are_cached(self):
        self.initialize_session()
        self.plugin._on_startup_complete()
        self.plugin._process_session(None)
        self.assertEqual(self.plugin._speech_settings_applied[0:2], (40, False))
        synth.rate = 50
        synth.rateBoost = True
        self.plugin._process_session("run-1")
        self.assertEqual(synth.rate, 40)
        self.assertFalse(synth.rateBoost)

    def test_driver_replacement_is_not_mistaken_for_the_cached_driver(self):
        self.plugin._agent_owned = True
        self.plugin._apply_speech_settings()
        replacement = types.SimpleNamespace(rate=50, rateBoost=True, isSupported=lambda key: True)
        with patch.object(module.synthDriverHandler, "getSynth", return_value=replacement):
            self.plugin._apply_speech_settings()
        self.assertEqual(replacement.rate, 40)
        self.assertFalse(replacement.rateBoost)
        self.assertIs(self.plugin._speech_settings_applied[2], replacement)

    def test_speech_hook_repairs_profile_reset_immediately_before_utterance(self):
        self.plugin._agent_owned = True
        self.plugin._apply_speech_settings()
        synth.rate = 50
        synth.rateBoost = True
        self.utterance()
        self.assertEqual(synth.rate, 40)
        self.assertFalse(synth.rateBoost)

    def test_personal_reader_stays_unchanged_at_capture_and_speech_handshakes(self):
        synth.rate = 50
        synth.rateBoost = True
        self.plugin._activate_capture("run-1", "action-1")
        self.utterance()
        self.assertEqual(synth.rate, 50)
        self.assertTrue(synth.rateBoost)

    def test_deferred_driver_readback_stays_truthful_and_logs_only_numeric_settings(self):
        class DeferredSynth:
            rateBoost = False
            def __init__(self):
                self.queued_rates = []
            def isSupported(self, key):
                return key in {"rate", "rateBoost"}
            @property
            def rate(self):
                return 50
            @rate.setter
            def rate(self, value):
                self.queued_rates.append(value)

        self.plugin._agent_owned = True
        deferred = DeferredSynth()
        with patch.object(module.synthDriverHandler, "getSynth", return_value=deferred), \
                patch.object(module.log, "info") as logged:
            self.plugin._apply_speech_settings("scope")
            self.assertEqual(deferred.queued_rates, [40])
            self.assertEqual(self.plugin._speech_settings_snapshot(), {"rate": 50, "rateBoost": False})
            logged.assert_called_once_with("RAMBO NVDA speech settings pending at scope: "
                                           "requested rate=40, rateBoost=False; actual rate=50, rateBoost=False.")

    def test_audio_idle_reads_effective_deferred_driver_rate_after_real_completion(self):
        class DeferredSynth:
            rateBoost = False
            def __init__(self):
                self.effective_rate = 50
                self.queued_rates = []
            def isSupported(self, key):
                return key in {"rate", "rateBoost"}
            @property
            def rate(self):
                return self.effective_rate
            @rate.setter
            def rate(self, value):
                self.queued_rates.append(value)
            def speak(self):
                # OneCore naturally applies queued parameter changes before
                # synthesizing its next utterance. The add-on never calls a
                # private queue method or writes the configured target back.
                if self.queued_rates:
                    self.effective_rate = self.queued_rates[-1]
                    self.queued_rates.clear()

        self.plugin._agent_owned = True
        deferred = DeferredSynth()
        with patch.object(module.synthDriverHandler, "getSynth", return_value=deferred):
            self.plugin._apply_speech_settings("scope")
            self.assertEqual(self.plugin._speech_settings_snapshot()["rate"], 50)
            self.utterance()
            deferred.speak()
            self.plugin._on_synth_index(synth=deferred, index=12)
            self.plugin._on_synth_done(synth=deferred)
            scheduled.pop()()
            idle = self.plugin._queue.get_nowait()
            self.assertEqual(idle["type"], "speech-idle")
            self.assertEqual(idle["speechSettings"], {"rate": 40, "rateBoost": False})
            self.utterance(13)
            deferred.speak()
            deferred.effective_rate = 45
            self.plugin._on_synth_index(synth=deferred, index=13)
            self.plugin._on_synth_done(synth=deferred)
            scheduled.pop()()
            self.assertEqual(self.plugin._queue.get_nowait()["speechSettings"]["rate"], 45,
                             "The driver's actual value must not be replaced by the configured target")

    def test_unavailable_startup_hook_never_grants_owned_capture(self):
        self.initialize_session()
        session = self.plugin._session
        sys.modules["globalVars"].appArgs = types.SimpleNamespace(configPath=".")
        worker = types.SimpleNamespace(start=lambda: None)
        with patch.object(module.GlobalPlugin, "_read_session", return_value=session), \
                patch.object(module.threading, "Thread", return_value=worker), \
                patch.object(startup_hook, "register", side_effect=RuntimeError("Unavailable")):
            instance = module.GlobalPlugin()
        try:
            instance._post = lambda payload: self.posted.append(payload) or True
            self.assertFalse(instance._startup_complete)
            self.assertEqual(instance._filter_speech(["Desktop"]), [])
            scheduled.pop(0)()
            self.assertEqual(exits, [True])
            self.assertEqual(self.posted[0]["type"], "scope-stopped")
        finally:
            instance.terminate()

    def test_initializing_is_quiet_and_has_no_foreground_or_command_permission(self):
        self.initialize_session()
        self.foreground.processID = 100
        self.plugin._session["capture"].update(active=True, command=self.command())
        self.focus.treeInterceptor = types.SimpleNamespace(passThrough=False,
            script_nextHeading=lambda gesture: self.fail("Startup must not execute commands"))
        self.plugin._watch_scope()
        self.assertEqual(exits, [], "NVDA initialization may finish its own Windows startup notification")
        self.assertEqual(self.plugin._filter_speech(["Settings window"]), [])
        self.plugin._on_speech(speechSequence=["Settings window"])
        self.plugin.event_alert(self.focus, lambda: self.fail("Startup must not dispatch website events"))
        self.assertIsNone(self.plugin._process_session(None))
        self.assertEqual(self.posted, [])
        self.assertTrue(self.plugin._queue.empty())
        self.plugin._execute_command(self.command(), "run-1")
        self.assertEqual(self.plugin._queue.get_nowait()["status"], "blocked")
        self.plugin._startup_complete = True
        self.plugin._process_session(None)
        self.assertEqual([item["type"] for item in self.posted], ["ready"])
        self.assertEqual(self.plugin._filter_speech(["Settings window"]), [], "Official initialization does not arm capture")

    def test_initializing_still_stops_on_close_expiry_or_missing_control(self):
        for change in (lambda: self.plugin._session.update(stopRequested=True),
                       lambda: self.plugin._session.update(expiresAtMs=1),
                       lambda: self.plugin._session.update(startupDeadlineMs=1),
                       lambda: setattr(self.plugin, "_session", None)):
            self.setUp()
            self.initialize_session()
            self.foreground.processID = 100
            change()
            self.plugin._watch_scope()
            self.assertEqual(exits, [True])
            self.assertEqual(self.posted[0]["type"], "scope-stopped")

    def test_absolute_startup_deadline_cannot_be_extended_with_lease_renewals(self):
        self.initialize_session()
        self.plugin._watch_scope()
        deadline = self.plugin._startup_deadline_ms
        self.plugin._session.update(startupDeadlineMs=deadline + 60000, expiresAtMs=deadline + 60000)
        self.plugin._watch_scope()
        self.assertEqual(self.plugin._startup_deadline_ms, deadline)
        with patch.object(module.time, "time", return_value=(deadline + 1) / 1000):
            self.plugin._watch_scope()
        self.assertEqual(exits, [True])

    def test_testing_scope_ack_requires_completed_startup_and_native_target(self):
        self.initialize_session()
        self.plugin._session["lifecycle"] = "testing"
        self.plugin._activate_scope("run-1", "scope-1")
        self.assertEqual(self.posted, [])
        self.assertFalse(self.plugin._handoff_complete)
        self.plugin._startup_complete = True
        self.plugin._process_session(None)
        self.assertEqual(self.posted[-1], {"type": "scope-ready", "scopeId": "scope-1", "initialized": True,
                                         "speechSettings": {"rate": 40, "rateBoost": False}})
        self.assertTrue(self.plugin._handoff_complete)
        self.assertEqual(self.plugin._ready_scope, ("run-1", "scope-1"))
        posted_count = len(self.posted)
        self.plugin._process_session("run-1")
        self.assertEqual(len(self.posted), posted_count, "A scope is acknowledged only once")
        self.plugin._session["capture"]["active"] = True
        self.assertEqual(self.plugin._filter_speech(["Website"]), ["Website"])

    def test_wrong_window_tab_stale_scope_and_expired_handoff_never_acknowledge(self):
        for change in (lambda: setattr(self.foreground, "processID", 100),
                       lambda: setattr(self.foreground, "windowHandle", 421),
                       lambda: setattr(self.foreground, "name", "Another Chrome tab"),
                       lambda: self.plugin._session.update(stopRequested=True),
                       lambda: self.plugin._session.update(startupDeadlineMs=1),
                       lambda: self.plugin._session.update(expiresAtMs=1)):
            self.setUp()
            self.initialize_session()
            self.plugin._startup_complete = True
            self.plugin._session["lifecycle"] = "testing"
            change()
            self.plugin._activate_scope("run-1", "scope-1")
            self.assertEqual(exits, [True])
            self.assertFalse(any(item["type"] == "scope-ready" for item in self.posted))
        self.setUp()
        self.initialize_session()
        self.plugin._startup_complete = True
        self.plugin._session["lifecycle"] = "testing"
        self.plugin._activate_scope("old-run", "scope-1")
        self.plugin._activate_scope("run-1", "old-scope")
        self.assertEqual(self.posted, [])
        self.assertFalse(self.plugin._handoff_complete)

    def test_testing_scope_lifetime_cannot_return_to_initialization_grace(self):
        self.initialize_session()
        self.plugin._startup_complete = True
        self.plugin._session["lifecycle"] = "testing"
        self.plugin._process_session(None)
        self.plugin._session["lifecycle"] = "initializing"
        self.plugin._session["capture"]["active"] = True
        self.assertEqual(self.plugin._filter_speech(["Outside"]), [])
        self.foreground.processID = 100
        self.plugin._watch_scope()
        self.assertEqual(exits, [True])

    def test_testing_lifecycle_without_scope_ack_cannot_capture_or_run(self):
        self.initialize_session()
        self.plugin._startup_complete = True
        self.plugin._session["lifecycle"] = "testing"
        self.plugin._session["capture"].update(active=True, command=self.command())
        self.assertEqual(self.plugin._filter_speech(["Website"]), [])
        self.plugin._execute_command(self.command(), "run-1")
        self.assertEqual(self.plugin._queue.get_nowait()["status"], "blocked")

    def test_startup_deadline_parser_rejects_nonfinite_and_bounds_absolute_deadline(self):
        import json
        for value, invalid in [(float("nan"), True), (float("inf"), True), (time.time() * 1000 + 99999999, False)]:
            payload = json.dumps({"endpoint": "http://127.0.0.1:4000", "token": "secret", "runId": "run-1",
                                 "lifecycle": "initializing", "scopeId": "scope-1", "agentOwnsReader": True,
                                 "startupDeadlineMs": value, "expiresAtMs": time.time() * 1000 + 45000,
                                 "browserScope": {"processId": 42, "windowHandle": "420", "titleMarker": "fixture-window"}})
            self.plugin._control_path = types.SimpleNamespace(read_text=lambda **kwargs: payload)
            session = self.plugin._read_session()
            if invalid:
                self.assertIsNone(session)
            else:
                self.assertLessEqual(session["startupDeadlineMs"], time.time() * 1000 + 310000)
                self.assertEqual(session["scopeId"], "scope-1")
                self.assertEqual(session["lifecycle"], "initializing")
                self.assertEqual(session["browserScope"], {"processId": 42, "windowHandle": 420,
                                                          "titleMarker": "fixture-window"})

    def test_owned_reader_exits_on_focus_loss_instead_of_staying_muted(self):
        self.plugin._agent_owned = True
        self.plugin._stopped = types.SimpleNamespace(is_set=lambda: False)
        posted = []
        self.plugin._post = lambda payload: posted.append(payload)
        self.foreground.name = "Another tab"
        for _ in range(module.CONTEXT_FAILURE_LIMIT - 1):
            self.plugin._watch_scope()
        self.assertEqual(exits, [], "A single unavailable sample is muted, not yet a departure")
        self.assertEqual(len(cancellations), module.CONTEXT_FAILURE_LIMIT - 1)
        scheduled.clear()
        self.plugin._watch_scope()
        self.assertEqual(exits, [True])
        self.assertEqual(posted[0]["type"], "scope-stopped")
        self.assertEqual(scheduled, [])
        self.plugin._watch_scope()
        self.assertEqual(exits, [True], "Shutdown must only be requested once")

    def test_one_sample_title_flicker_does_not_stop_the_reader(self):
        self.plugin._agent_owned = True
        self.plugin._stopped = types.SimpleNamespace(is_set=lambda: False)
        self.foreground.name = "Page updating"
        self.plugin._watch_scope()
        self.foreground.name = "fixture-window - Chromium"
        self.plugin._watch_scope()
        self.foreground.name = "Page updating"
        for _ in range(module.CONTEXT_FAILURE_LIMIT - 1):
            self.plugin._watch_scope()
        self.assertEqual(exits, [], "Failures must be consecutive")
        self.assertEqual(self.plugin._filter_speech(["Leaked speech"]), [], "Speech stays filtered while unavailable")

    def test_owned_reader_exits_after_tab_close_control_removal_or_lease_expiry(self):
        for change in (lambda: self.plugin._session.update(stopRequested=True),
                       lambda: setattr(self.plugin, "_session", None),
                       lambda: self.plugin._session.update(expiresAtMs=1)):
            self.setUp()
            self.plugin._agent_owned = True
            self.plugin._stopped = types.SimpleNamespace(is_set=lambda: False)
            change()
            self.plugin._watch_scope()
            self.assertEqual(exits, [True])

    def test_a_personal_reader_is_never_terminated_by_test_tab_shutdown(self):
        self.plugin._stop_owned_reader("Tab closed")
        self.assertEqual(exits, [])

    def test_leaving_chrome_exits_even_between_commands(self):
        self.plugin._agent_owned = True
        self.plugin._stopped = types.SimpleNamespace(is_set=lambda: False)
        self.plugin._session["capture"]["active"] = False
        self.plugin._session["browserScope"] = {"processId": 42, "windowHandle": 420}
        self.foreground.processID = 100
        self.plugin._watch_scope()
        self.assertEqual(exits, [True])

    def test_native_foreground_not_the_cached_nvda_object_controls_lifetime(self):
        self.plugin._agent_owned = True
        self.plugin._stopped = types.SimpleNamespace(is_set=lambda: False)
        self.plugin._session["capture"]["active"] = False
        self.plugin._session["browserScope"] = {"processId": 42, "windowHandle": 420}
        win_user.getForegroundWindow = lambda: 420
        win_user.getWindowThreadProcessID = lambda handle: (42, 1)
        self.foreground.processID = 100
        self.plugin._watch_scope()
        self.assertEqual(exits, [], "A stale NVDA cache must not stop the correctly focused test")
        self.foreground.processID = 42
        win_user.getForegroundWindow = lambda: 999
        win_user.getWindowThreadProcessID = lambda handle: (100, 1)
        self.plugin._watch_scope()
        self.assertEqual(exits, [True], "A stale cache must not keep NVDA running outside Chrome")

    def test_queued_commands_cannot_execute_once_shutdown_started(self):
        self.plugin._exit_requested = True
        self.focus.treeInterceptor = types.SimpleNamespace(passThrough=False, script_nextHeading=lambda gesture: self.fail("Shutdown must cancel queued commands"))
        self.plugin._execute_command(self.command(), "run-1")
        self.assertEqual(self.plugin._queue.get_nowait()["status"], "blocked")
        self.assertEqual(self.plugin._filter_speech(["Old queued speech"]), [])

    def test_disarm_acknowledges_after_canceling_old_speech(self):
        self.plugin._session["capture"]["active"] = False
        self.plugin._session["disarmId"] = "disarm-1"
        self.plugin._disarm_capture("run-1", "disarm-1")
        self.assertEqual(cancellations, [True])
        self.assertEqual(self.posted, [{"type": "capture-disarmed", "disarmId": "disarm-1"}])

    def test_speech_filter_allows_test_document_but_mutes_other_apps_tabs_and_toolbar(self):
        sequence = ["Close", "button"]
        self.assertIs(self.plugin._filter_speech(sequence), sequence)
        for change in (lambda: setattr(self.foreground, "processID", 100),
                       lambda: setattr(self.foreground, "name", "Other browser tab"),
                       lambda: setattr(self.foreground, "windowHandle", 421),
                       lambda: setattr(self.focus, "parent", self.foreground),
                       lambda: self.focus.states.add("protected")):
            self.setUp()
            change()
            self.assertEqual(self.plugin._filter_speech(sequence), [])

    def test_inactive_expired_or_incomplete_scope_cannot_speak_or_capture(self):
        for change in (lambda: self.plugin._session["capture"].update(active=False),
                       lambda: self.plugin._session.update(expiresAtMs=1),
                       lambda: self.plugin._session["capture"].update(windowHandle=0),
                       lambda: self.plugin._session["capture"].update(titleMarker="")):
            self.setUp()
            change()
            self.assertEqual(self.plugin._filter_speech(["Outside test"]), [])
            self.plugin._on_speech(speechSequence=["Outside test"])
            self.assertTrue(self.plugin._queue.empty())

    def test_agent_owned_reader_is_quiet_before_startup_and_after_missing_control(self):
        self.plugin._agent_owned = True
        self.plugin._session = None
        self.assertEqual(self.plugin._filter_speech(["Desktop"]), [])
        self.plugin._session = {"capture": {"active": False}}
        self.assertEqual(self.plugin._filter_speech(["Desktop"]), [])

    def test_preexisting_reader_restores_normal_speech_outside_agent_session(self):
        sequence = ["User's normal reader"]
        self.plugin._session = None
        self.assertIs(self.plugin._filter_speech(sequence), sequence)

    def test_scope_watch_interrupts_queued_speech_after_focus_change(self):
        self.plugin._stopped = types.SimpleNamespace(is_set=lambda: False)
        self.foreground.processID = 77
        self.plugin._watch_scope()
        self.assertEqual(len(cancellations), 1)
        self.assertEqual(len(scheduled), 1)
        self.plugin._stopped = types.SimpleNamespace(is_set=lambda: True)
        scheduled.pop()()
        self.assertEqual(scheduled, [])

    def test_capture_ack_is_sent_after_queued_speech_is_canceled(self):
        self.plugin._activate_capture("run-1", "action-1")
        self.assertEqual(cancellations, [True])
        self.assertEqual(self.posted, [{"type": "capture-ready", "actionId": "action-1"}])
        self.plugin._activate_capture("old-run", "action-1")
        self.assertTrue(self.plugin._queue.empty())

    def test_native_tab_title_not_stale_cached_name_controls_capture(self):
        self.foreground.name = "Previous page title"
        win_user.getWindowText = lambda handle: "fixture-window - Chromium"
        self.plugin._activate_capture("run-1", "action-1")
        self.assertEqual(self.posted[-1]["type"], "capture-ready")
        sequence = ["Website speech"]
        self.assertIs(self.plugin._filter_speech(sequence), sequence)
        win_user.getWindowText = lambda handle: "Different tab"
        self.assertEqual(self.plugin._filter_speech(["Outside speech"]), [])

    def test_capture_waits_for_native_document_focus_without_authorizing_commands(self):
        self.plugin._agent_owned = True
        self.plugin._ready_capture = None
        self.plugin._stopped = types.SimpleNamespace(is_set=lambda: False)
        self.focus.parent = None
        self.plugin._activate_capture("run-1", "action-1")
        self.assertTrue(self.plugin._queue.empty())
        self.assertEqual(exits, [])
        self.plugin._watch_scope()
        self.assertEqual(exits, [], "Pending native focus is not a confirmed departure")
        self.focus.parent = self.document
        scheduled.pop(0)()
        self.assertEqual(self.posted[-1]["type"], "capture-ready")
        self.assertEqual(self.plugin._ready_capture, "action-1")

    def test_document_readiness_timeout_stops_owned_reader(self):
        self.plugin._agent_owned = True
        self.plugin._ready_capture = None
        self.focus.parent = None
        self.plugin._activate_capture("run-1", "action-1", time.monotonic() - 1)
        self.assertEqual(exits, [True])
        self.assertTrue(self.plugin._queue.empty())

    def test_disarm_ack_is_not_delayed_by_speech_backlog(self):
        for _ in range(100):
            self.plugin._queue.put_nowait({"type": "speech", "text": "Fixture"})
        self.plugin._session["capture"]["active"] = False
        self.plugin._session["disarmId"] = "priority-disarm"
        self.plugin._disarm_capture("run-1", "priority-disarm")
        self.assertEqual(self.posted[-1], {"type": "capture-disarmed", "disarmId": "priority-disarm"})
        self.assertEqual(self.plugin._queue.qsize(), 100)

    def test_leaving_chrome_during_readiness_still_stops_reader(self):
        self.plugin._agent_owned = True
        self.plugin._ready_capture = None
        self.plugin._stopped = types.SimpleNamespace(is_set=lambda: False)
        self.plugin._session["browserScope"] = {"processId": 42, "windowHandle": 420}
        self.foreground.processID = 100
        self.plugin._watch_scope()
        self.assertEqual(exits, [True])

    def pausable_session(self):
        # Owned reader past its startup handoff, controller opted in, armed.
        self.initialize_session()
        self.plugin._on_startup_complete()
        self.plugin._session.update(lifecycle="testing", pauseResume=True)
        self.plugin._process_session(None)
        self.assertEqual([item["type"] for item in self.posted], ["ready", "scope-ready"])
        self.plugin._session["capture"]["active"] = True
        self.plugin._activate_capture("run-1", "action-1")
        self.assertEqual(self.posted[-1]["type"], "capture-ready")
        self.posted.clear()
        scheduled.clear()
        cancellations.clear()

    def pause_by_leaving_chrome(self):
        self.foreground.processID = 100
        self.plugin._watch_scope()
        self.assertEqual(exits, [])
        self.assertEqual([item["type"] for item in self.posted], ["scope-paused"])
        self.posted.clear()
        scheduled.clear()

    def resume_target(self, scope_id, marker="RAMBO NVDA run-1 r1"):
        # What the controller writes to resume: a fresh marker, a new scope, capture inactive.
        self.plugin._session.update(lifecycle="testing", scopeId=scope_id,
                                    browserScope={"processId": 42, "windowHandle": 420, "titleMarker": marker})
        self.plugin._session["capture"]["active"] = False

    def test_opted_in_reader_pauses_instead_of_exiting_when_focus_leaves_chrome(self):
        self.pausable_session()
        self.foreground.processID = 100
        started = time.time() * 1000
        self.plugin._watch_scope()
        self.assertEqual(exits, [], "A foreign foreground pauses an opted-in reader")
        self.assertEqual(len(self.posted), 1)
        paused = self.posted[0]
        self.assertEqual((paused["type"], paused["scopeId"]), ("scope-paused", "scope-1"))
        self.assertNotRegex(paused["reason"], r"closed|stopped|shutting down|unavailable")
        self.assertGreater(paused["deadlineMs"], started)
        self.assertLessEqual(paused["deadlineMs"], time.time() * 1000 + module.MAX_PAUSE_MS)
        self.assertIsNone(self.plugin._ready_scope)
        self.assertIsNone(self.plugin._ready_capture)
        self.assertTrue(cancellations, "Speech already queued is interrupted")
        self.assertEqual(len(scheduled), 1, "The watch keeps running while paused")
        self.posted.clear()
        self.foreground.processID = 42
        self.assertEqual(self.plugin._filter_speech(["Desktop speech"]), [], "A paused reader stays muted")
        self.plugin._on_speech(speechSequence=["Desktop speech"])
        self.assertTrue(self.plugin._queue.empty())
        self.plugin.event_alert(self.focus, lambda: self.fail("A paused reader must not dispatch website events"))
        self.focus.treeInterceptor = types.SimpleNamespace(passThrough=False,
            script_nextHeading=lambda gesture: self.fail("A paused reader must not execute commands"))
        self.plugin._execute_command(self.command(), "run-1")
        result = self.plugin._queue.get_nowait()
        self.assertEqual(result["status"], "blocked")
        self.assertIn("paused", result["reason"])
        self.plugin._activate_capture("run-1", "action-1")
        self.assertEqual(self.posted, [], "Capture is refused while paused")
        self.plugin._session["capture"]["active"] = False
        self.plugin._session["disarmId"] = "disarm-1"
        self.plugin._process_session("run-1")
        self.assertEqual(self.posted, [{"type": "capture-disarmed", "disarmId": "disarm-1"}],
                         "The controller needs the disarm ack to pause")
        self.posted.clear()
        self.foreground.processID = 100
        for _ in range(3):
            scheduled.pop()()
        self.assertEqual((exits, self.posted), ([], []), "Further paused ticks neither exit nor repost")
        self.assertEqual(len(scheduled), 1)

    def test_opted_in_tab_switch_during_armed_command_pauses_after_debounce(self):
        self.pausable_session()
        self.foreground.name = "Another tab"
        for _ in range(module.CONTEXT_FAILURE_LIMIT - 1):
            self.plugin._watch_scope()
        self.assertEqual((exits, self.posted), ([], []))
        self.plugin._watch_scope()
        self.assertEqual(exits, [])
        self.assertEqual([item["type"] for item in self.posted], ["scope-paused"])
        self.assertIsNotNone(self.plugin._paused)
        self.assertEqual(self.plugin._context_failures, 0)

    def test_opted_in_document_readiness_timeout_pauses(self):
        self.pausable_session()
        self.plugin._ready_capture = None
        self.focus.parent = None
        self.plugin._session["capture"]["actionId"] = "action-2"
        self.plugin._activate_capture("run-1", "action-2", time.monotonic() - 1)
        self.assertEqual(exits, [])
        self.assertEqual([item["type"] for item in self.posted], ["scope-paused"])

    def test_arm_while_paused_reposts_scope_paused_once(self):
        self.pausable_session()
        self.pause_by_leaving_chrome()
        self.plugin._session["capture"].update(active=True, actionId="action-2")
        self.plugin._process_session("run-1")
        self.plugin._process_session("run-1")
        self.assertEqual([item["type"] for item in self.posted], ["scope-paused"])
        self.assertEqual(self.posted[0]["scopeId"], "scope-1")
        self.assertIsNone(self.plugin._announced_capture, "The same action can be armed again after resume")

    def test_new_scope_with_correct_foreground_and_title_resumes(self):
        self.pausable_session()
        self.pause_by_leaving_chrome()
        self.foreground.processID = 42
        self.foreground.name = "fixture-window RAMBO NVDA run-1 r1 - Chromium"
        self.plugin._session["capture"]["active"] = False
        self.plugin._process_session("run-1")
        self.assertEqual(self.posted, [], "The lost scope id can never be acknowledged again")
        self.assertIsNotNone(self.plugin._paused)
        self.resume_target("scope-2")
        self.plugin._process_session("run-1")
        self.assertEqual(self.posted[-1]["type"], "scope-ready")
        self.assertEqual(self.posted[-1]["scopeId"], "scope-2")
        self.assertIsNone(self.plugin._paused)
        self.assertIsNone(self.plugin._pause_deadline_ms)
        self.assertEqual(self.plugin._ready_scope, ("run-1", "scope-2"))
        self.plugin._session["capture"].update(active=True, actionId="action-2")
        self.plugin._process_session("run-1")
        self.assertEqual(self.posted[-1], {"type": "capture-ready", "actionId": "action-2"})
        self.assertEqual(self.plugin._filter_speech(["Website"]), ["Website"])
        scheduled.clear()
        self.plugin._watch_scope()
        self.assertEqual((exits, len(scheduled)), ([], 1))

    def test_rejected_resume_stays_paused_without_exiting(self):
        for name, change in (("title", lambda: None),
                             ("window", lambda: setattr(self.foreground, "processID", 100))):
            with self.subTest(failure=name):
                self.setUp()
                self.pausable_session()
                self.pause_by_leaving_chrome()
                self.foreground.processID = 42
                change()
                self.resume_target("scope-2")
                self.plugin._process_session("run-1")
                self.assertEqual(exits, [])
                self.assertEqual(len(self.posted), 1)
                self.assertEqual((self.posted[0]["type"], self.posted[0]["scopeId"], self.posted[0]["reason"]),
                                 ("scope-paused", "scope-2", "resume rejected"))
                self.assertIsNotNone(self.plugin._paused)
                self.assertIsNone(self.plugin._ready_scope)
                self.assertEqual(self.plugin._filter_speech(["Desktop"]), [])
                self.posted.clear()
                self.foreground.processID = 42
                self.foreground.name = "RAMBO NVDA run-1 r1 - Chromium"
                self.resume_target("scope-3")
                self.plugin._process_session("run-1")
                self.assertEqual(self.posted[-1]["type"], "scope-ready")
                self.assertEqual(self.posted[-1]["scopeId"], "scope-3")
                self.assertIsNone(self.plugin._paused)

    def test_pause_deadline_is_absolute_and_expiry_exits_with_scope_stopped(self):
        self.pausable_session()
        deadline = time.time() * 1000 + 30000
        # Controller-initiated pause: no foreground check while it holds focus elsewhere.
        self.plugin._session.update(lifecycle="paused", pauseDeadlineMs=deadline)
        self.plugin._session["capture"]["active"] = False
        self.foreground.processID = 100
        self.plugin._watch_scope()
        self.assertEqual(exits, [])
        self.assertEqual([item["type"] for item in self.posted], ["scope-paused"])
        self.assertEqual(self.posted[0]["deadlineMs"], int(deadline))
        self.plugin._session.update(pauseDeadlineMs=deadline + 60000, expiresAtMs=deadline + 120000)
        scheduled.pop()()
        self.assertEqual(self.plugin._pause_deadline_ms, deadline, "Heartbeats and rewrites cannot extend a pause")
        with patch.object(module.time, "time", return_value=(deadline + 1) / 1000):
            scheduled.pop()()
        self.assertEqual(exits, [True])
        self.assertEqual(self.posted[-1]["type"], "scope-stopped")
        self.assertEqual(scheduled, [])

    def test_stale_controller_deadline_from_an_earlier_pause_is_ignored(self):
        self.pausable_session()
        self.plugin._session["pauseDeadlineMs"] = time.time() * 1000 - 1000
        self.pause_by_leaving_chrome()
        scheduled.clear()
        self.plugin._watch_scope()
        self.assertEqual(exits, [], "A deadline is only read while the controller says lifecycle paused")

    def test_stop_lease_expiry_or_missing_control_still_exit_while_paused(self):
        for change in (lambda: self.plugin._session.update(stopRequested=True),
                       lambda: self.plugin._session.update(expiresAtMs=1),
                       lambda: setattr(self.plugin, "_session", None)):
            self.setUp()
            self.pausable_session()
            self.pause_by_leaving_chrome()
            change()
            self.plugin._watch_scope()
            self.assertEqual(exits, [True])
            self.assertEqual(self.posted[-1]["type"], "scope-stopped")
            self.assertEqual(scheduled, [])

    def test_idle_context_failures_reset_on_arm_and_disarm(self):
        self.plugin._agent_owned = True
        self.plugin._session["capture"]["active"] = False
        for _ in range(module.CONTEXT_FAILURE_LIMIT + 2):
            self.plugin._watch_scope()
        self.assertGreaterEqual(self.plugin._context_failures, module.CONTEXT_FAILURE_LIMIT)
        self.plugin._session["capture"]["active"] = True
        self.plugin._activate_capture("run-1", "action-1")
        self.assertEqual(self.plugin._context_failures, 0)
        self.foreground.name = "Another tab"
        self.plugin._watch_scope()
        self.assertEqual(exits, [], "The first failing tick after an arm is not yet a departure")
        self.plugin._context_failures = module.CONTEXT_FAILURE_LIMIT + 2
        self.plugin._session["capture"]["active"] = False
        self.plugin._session["disarmId"] = "disarm-1"
        self.plugin._disarm_capture("run-1", "disarm-1")
        self.assertEqual(self.plugin._context_failures, 0)

    def test_first_startup_handoff_failure_still_stops_with_pause_resume(self):
        for change in (lambda: setattr(self.foreground, "processID", 100),
                       lambda: setattr(self.foreground, "name", "Another Chrome tab")):
            self.setUp()
            self.initialize_session()
            self.plugin._startup_complete = True
            self.plugin._session.update(lifecycle="testing", pauseResume=True)
            change()
            self.plugin._activate_scope("run-1", "scope-1")
            self.assertEqual(exits, [True])
            self.assertEqual([item["type"] for item in self.posted], ["scope-stopped"])
        self.setUp()
        self.initialize_session()
        self.plugin._startup_complete = True
        self.plugin._session.update(lifecycle="testing", pauseResume=True)
        self.foreground.processID = 100
        self.plugin._watch_scope()
        self.assertEqual(exits, [True], "Before the first handoff a foreign foreground still stops")

    def test_without_pause_resume_a_paused_lifecycle_and_rehandoff_keep_stop_behaviour(self):
        self.pausable_session()
        self.plugin._session["pauseResume"] = False
        self.resume_target("scope-2")
        self.plugin._process_session("run-1")
        self.assertEqual(exits, [True], "A failed re-handoff without the opt-in stops as before")
        self.setUp()
        self.pausable_session()
        self.plugin._session.update(pauseResume=False, lifecycle="paused")
        self.foreground.processID = 100
        self.plugin._watch_scope()
        self.assertEqual(exits, [True])
        self.assertIsNone(self.plugin._paused)

    def test_a_personal_reader_is_never_paused(self):
        self.plugin._pause_owned_reader("Fixture pause")
        self.assertIsNone(self.plugin._paused)
        self.assertEqual(self.posted, [])

    def test_pause_fields_are_whitelisted_and_bounded(self):
        import json
        now = time.time() * 1000
        for pause_resume, deadline, expected_resume, expected_deadline in [
                (True, now + 99999999, True, None), ("true", now + 30000, False, now + 30000),
                (1, None, False, 0), (True, True, True, 0), (True, "123", True, 0), (True, float("nan"), True, 0),
                (True, -5, True, 0)]:
            with self.subTest(pause_resume=pause_resume, deadline=deadline):
                payload = json.dumps({"endpoint": "http://127.0.0.1:4000", "token": "secret", "runId": "run-1",
                                      "lifecycle": "paused", "pauseResume": pause_resume, "pauseDeadlineMs": deadline,
                                      "expiresAtMs": now + 45000})
                self.plugin._control_path = types.SimpleNamespace(read_text=lambda **kwargs: payload)
                session = self.plugin._read_session()
                self.assertEqual(session["lifecycle"], "paused")
                self.assertIs(session["pauseResume"], expected_resume)
                if expected_deadline is None:
                    self.assertLessEqual(session["pauseDeadlineMs"], time.time() * 1000 + module.MAX_PAUSE_MS)
                    self.assertGreater(session["pauseDeadlineMs"], now)
                else:
                    self.assertEqual(session["pauseDeadlineMs"], expected_deadline)

    def test_background_alerts_are_blocked_but_current_document_live_regions_work(self):
        calls = []
        self.plugin.event_alert(node(parent=node(role="document", name="Other tab")), lambda: calls.append("outside"))
        self.plugin.event_liveRegionChange(node(parent=self.document), lambda: calls.append("inside"))
        self.assertEqual(calls, ["inside"])

    def test_preserves_real_website_close_button(self):
        self.plugin._on_speech(speechSequence=["Close", "button"])
        event = self.plugin._queue.get_nowait()
        self.assertEqual(event["text"], "Close button")
        self.assertTrue(event["inDocument"])
        self.assertFalse(event["focusIsDocument"])

    def test_windows_toasts_are_filtered_by_source_without_blocking_website_notifications(self):
        for event in ("UIA_window_windowOpen", "UIA_toolTipOpened", "UIA_systemAlert", "UIA_notification"):
            calls = []
            handler = getattr(self.plugin, "event_" + event)
            handler(node(name="Update available", pid=999), lambda: calls.append("desktop"), displayString="Update available")
            handler(node(name="Update available", parent=self.document), lambda: calls.append("website"), displayString="Update available")
            self.assertEqual(calls, ["website"], event)

    def test_discards_same_browser_toolbar_close_button(self):
        self.focus = node(parent=self.foreground)
        self.plugin._on_speech(speechSequence=["Close button"])
        self.assertTrue(self.plugin._queue.empty())

    def test_discards_other_apps_and_protected_fields(self):
        self.foreground.processID = 100
        self.plugin._on_speech(speechSequence=["Other application"])
        self.foreground.processID = 42
        self.focus.states.add("protected")
        self.plugin._on_speech(speechSequence=["secret"])
        self.assertTrue(self.plugin._queue.empty())

    def test_marks_document_handoff(self):
        self.focus = self.document
        self.plugin._on_speech(speechSequence=["Fixture document"])
        self.assertTrue(self.plugin._queue.get_nowait()["focusIsDocument"])

    def command(self, kind="next-heading", **kwargs):
        return {"id": "action-1", "kind": kind, "maxDurationMs": 100, **kwargs}

    def test_browse_navigation_calls_nvda_script_without_typing(self):
        calls = []
        self.focus.treeInterceptor = types.SimpleNamespace(passThrough=False, script_nextHeading=lambda gesture: calls.append(gesture))
        self.plugin._execute_command(self.command(), "run-1")
        self.assertEqual(calls, [None])
        self.assertEqual(self.plugin._queue.get_nowait()["status"], "executed")

    def test_browser_chrome_other_app_and_protected_input_block_commands(self):
        for change in (lambda: setattr(self.foreground, "processID", 999),
                       lambda: setattr(self.foreground, "name", "another page"),
                       lambda: setattr(self.focus, "parent", None),
                       lambda: self.focus.states.add("protected")):
            self.setUp()
            change()
            self.plugin._execute_command(self.command(), "run-1")
            self.assertEqual(self.plugin._queue.get_nowait()["status"], "blocked")

    def test_focus_mode_is_skipped_without_sending_letters(self):
        self.focus.treeInterceptor = types.SimpleNamespace(passThrough=True)
        self.plugin._execute_command(self.command(), "run-1")
        result = self.plugin._queue.get_nowait()
        self.assertEqual(result["status"], "skipped")
        self.assertIn("no keys were typed", result["reason"])

    def test_new_state_anchor_waits_for_browse_buffer_without_typing(self):
        calls = []
        position = types.SimpleNamespace(collapse=lambda: None)
        lookups = [LookupError(), position]
        def locate(focus):
            self.assertIs(focus, self.focus)
            value = lookups.pop(0)
            if isinstance(value, Exception):
                raise value
            return value
        self.focus.treeInterceptor = types.SimpleNamespace(passThrough=False, makeTextInfo=locate,
            script_nextHeading=lambda gesture: calls.append(gesture))
        self.plugin._execute_command(self.command(resetPosition=True), "run-1")
        self.assertEqual(calls, [])
        self.assertTrue(self.plugin._queue.empty())
        scheduled.pop()()
        self.assertEqual(calls, [None])
        self.assertIs(self.focus.treeInterceptor.selection, position)
        self.assertEqual(self.plugin._queue.get_nowait()["status"], "executed")

    def test_unresolved_anchor_has_bounded_retry_and_useful_failure(self):
        def missing(_focus):
            raise LookupError()
        self.focus.treeInterceptor = types.SimpleNamespace(passThrough=False, makeTextInfo=missing)
        self.plugin._execute_command(self.command("say-all", resetPosition=True), "run-1")
        for _ in range(20):
            self.assertEqual(len(scheduled), 1)
            scheduled.pop()()
        self.assertEqual(scheduled, [])
        self.assertIsNone(self.plugin._reading_command)
        result = self.plugin._queue.get_nowait()
        self.assertEqual(result["status"], "blocked")
        self.assertIn("focus anchor after 2 seconds", result["reason"])

    def test_anchor_retry_rechecks_scope_before_executing(self):
        def missing(_focus):
            raise LookupError()
        self.focus.treeInterceptor = types.SimpleNamespace(passThrough=False, makeTextInfo=missing)
        self.plugin._execute_command(self.command("say-all", resetPosition=True), "run-1")
        self.foreground.processID = 999
        scheduled.pop()()
        self.assertEqual(scheduled, [])
        self.assertIsNone(self.plugin._reading_command)
        self.assertEqual(self.plugin._queue.get_nowait()["status"], "blocked")

    def test_reading_is_bounded_partial_and_stops_when_focus_changes(self):
        self.focus.treeInterceptor = types.SimpleNamespace(passThrough=False)
        self.plugin._execute_command(self.command("say-all"), "run-1")
        self.assertEqual(len(scheduled), 1)
        self.plugin._reading_command["started"] -= 1
        scheduled.pop()()
        self.assertEqual(self.plugin._queue.get_nowait()["status"], "partial")
        self.plugin._execute_command(self.command("say-all"), "run-1")
        self.foreground.processID = 999
        scheduled.pop()()
        self.assertEqual(self.plugin._queue.get_nowait()["status"], "blocked")
        self.assertIsNone(self.plugin._reading_command)

    def test_browse_speech_is_retained_when_anchor_has_native_focus(self):
        self.focus.name = "Accessibility test start"
        self.plugin._session["capture"]["command"] = self.command()
        self.plugin._on_speech(speechSequence=["Account overview", "heading level 1"])
        self.assertFalse(self.plugin._queue.get_nowait()["isFocusAnchor"])

    def test_stale_commands_never_execute(self):
        self.plugin._execute_command(self.command(), "old-run")
        self.assertEqual(self.plugin._queue.get_nowait()["status"], "blocked")

    def test_control_protocol_only_accepts_allowed_commands_and_bounds_duration(self):
        import json
        for kind, allowed in [("say-all", True), ("submit-form", False)]:
            payload = json.dumps({"endpoint": "http://127.0.0.1:4000", "token": "secret", "runId": "run-1",
                "capture": {"active": True, "actionId": "action-1", "processId": 42,
                            "windowHandle": "420",
                            "command": self.command(kind, maxDurationMs=9999999)}})
            self.plugin._control_path = types.SimpleNamespace(read_text=lambda **kwargs: payload)
            capture = self.plugin._read_session()["capture"]
            self.assertEqual("command" in capture, allowed)
            self.assertEqual(capture["windowHandle"], 420)
            if allowed:
                self.assertEqual(capture["command"]["maxDurationMs"], 1800000)

    def test_reading_waits_past_old_sample_and_requires_audio_and_end_position(self):
        position = types.SimpleNamespace(copy=lambda: position, expand=lambda unit: None,
                                         compareEndPoints=lambda end, relation: 0)
        self.focus.treeInterceptor = types.SimpleNamespace(passThrough=False, selection=position,
                                                           makeTextInfo=lambda which: object())
        self.plugin._execute_command(self.command("say-all", maxDurationMs=300000), "run-1")
        active = self.plugin._reading_command
        active["started"] -= 40
        with patch.object(say_all.SayAllHandler, "isRunning", return_value=True):
            scheduled.pop()()
        self.assertTrue(self.plugin._queue.empty(), "Reading must not stop at the old 30-second cap")
        active["speechSeen"] = True
        scheduled.pop()()
        self.assertTrue(self.plugin._queue.empty(), "Stopped Say All is not proof the final audio finished")
        active["audioFinished"] = True
        before = len(cancellations)
        scheduled.pop()()
        result = self.plugin._queue.get_nowait()
        self.assertEqual(result["status"], "executed")
        self.assertEqual(result["readingCompletion"], "completed")
        self.assertTrue(result["audibleComplete"])
        self.assertEqual(len(cancellations), before, "Natural completion must not cancel the final words")

    def test_stopped_reading_without_verified_end_is_not_completed(self):
        self.focus.treeInterceptor = types.SimpleNamespace(passThrough=False)
        self.plugin._execute_command(self.command("say-all", maxDurationMs=300000), "run-1")
        self.plugin._reading_command.update(speechSeen=True, audioFinished=True)
        scheduled.pop()()
        result = self.plugin._queue.get_nowait()
        self.assertEqual(result["status"], "partial")
        self.assertEqual(result["readingCompletion"], "unconfirmed")

    def test_reading_cannot_complete_without_speech(self):
        self.focus.treeInterceptor = types.SimpleNamespace(passThrough=False)
        self.plugin._execute_command(self.command("say-all"), "run-1")
        self.plugin._reading_command.update(started=time.monotonic() - 1, audioFinished=True)
        scheduled.pop()()
        result = self.plugin._queue.get_nowait()
        self.assertEqual(result["readingCompletion"], "timed-out")
        self.assertFalse(result["audibleComplete"])


if __name__ == "__main__":
    unittest.main()
