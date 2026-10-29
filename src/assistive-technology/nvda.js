// Stable public facade. Implementation modules never import this entry point.
// Importing these exports does not launch NVDA or a native helper.
export { detectNvdaCapability } from "./nvda/capability.js";
export { runNvdaWebsiteTest } from "./nvda/replay.js";
export { selectNvdaAnnouncements, waitForActionSpeech } from "./nvda/speech.js";
export { startNvdaCaptureSession } from "./nvda/capture-session.js";
export { createNvdaCaptureReceiver } from "./nvda/capture-receiver.js";
export { checkNvdaRunning } from "./nvda/process.js";
export { probeNvdaRunning, warmNvdaKeyboardHelper, releaseWarmedNvdaHelper, focusAndMaximizeBrowser, sendNativeTab, focusNativeDocumentAnchor, inspectNativeDocumentFocus, prepareNativeDocumentFocus, startKeyHelper, closeKeyHelper, runPowerShellHelper } from "./nvda/native-keyboard.js";
export { establishPageKeyboardFocus, describeFocusedElement } from "./nvda/browser-focus.js";
export { writeControlFile } from "./nvda/control-file.js";
