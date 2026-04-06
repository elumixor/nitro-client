import { clearLog } from "./log";
import { demoSimpleGet } from "./demos/get-simple";
import { demoPostWithBody } from "./demos/post-with-body";
import { demoSseStreaming } from "./demos/sse-streaming";
import { demoSseBackgroundJob } from "./demos/sse-background-job";
import { demoWebSocket } from "./demos/websocket";

// Wire each button to its demo handler.
document.getElementById("btn-hello")!.addEventListener("click", demoSimpleGet);
document.getElementById("btn-greet")!.addEventListener("click", demoPostWithBody);
document.getElementById("btn-countdown")!.addEventListener("click", demoSseStreaming);
document.getElementById("btn-process")!.addEventListener("click", demoSseBackgroundJob);
document.getElementById("btn-chat")!.addEventListener("click", demoWebSocket);

// Clear log (header + footer buttons).
document.getElementById("btn-clear")!.addEventListener("click", clearLog);
document.getElementById("btn-clear-footer")!.addEventListener("click", (e) => {
  e.preventDefault();
  clearLog();
});
