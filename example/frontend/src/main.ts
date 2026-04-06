import { NitroAPI } from "backend";

const api = new NitroAPI({ baseUrl: "" });
const log = document.getElementById("log")!;

let firstEntry = true;

function write(msg: string, cls = "data") {
  if (firstEntry) {
    log.innerHTML = "";
    firstEntry = false;
  }
  const line = document.createElement("span");
  line.className = `log-line ${cls}`;
  line.textContent = msg;
  log.appendChild(line);
  log.appendChild(document.createTextNode("\n"));
  log.scrollTop = log.scrollHeight;
}

function sep(label: string, protocol: "get" | "post" | "sse" | "ws") {
  if (!firstEntry) {
    const spacer = document.createElement("span");
    spacer.className = "log-spacer";
    log.appendChild(spacer);
  }
  write(label, `header ${protocol}`);
}

function clearLog() {
  log.innerHTML = '<span class="log-hint">↑ Click a command to see output</span>';
  firstEntry = true;
}

document.getElementById("btn-clear")!.addEventListener("click", clearLog);
document.getElementById("btn-clear-footer")!.addEventListener("click", (e) => {
  e.preventDefault();
  clearLog();
});

document.getElementById("btn-hello")!.addEventListener("click", async () => {
  sep("GET /hello", "get");
  const res = await api.hello.$get();
  write(JSON.stringify(res, null, 2));
});

document.getElementById("btn-greet")!.addEventListener("click", async () => {
  sep("POST /greet", "post");
  const res = await api.greet.$post({ name: "World" });
  write(JSON.stringify(res, null, 2));
});

document.getElementById("btn-countdown")!.addEventListener("click", async () => {
  sep("SSE /countdown", "sse");
  const stream = api.countdown.$post({ from: 3 });
  for await (const event of stream) {
    write(`  ${JSON.stringify(event)}`);
  }
  const result = await stream.done;
  write(`  return: ${JSON.stringify(result)}`, "result");
});

document.getElementById("btn-process")!.addEventListener("click", async () => {
  sep("SSE /process (jobs)", "sse");
  try {
    const stream = api.process.$post({ task: "my-task" });
    const jobId = await stream.id;
    write(`  jobId: ${jobId}`, "meta");
    for await (const event of stream) {
      write(`  ${JSON.stringify(event)}`);
    }
    const result = await stream.done;
    write(`  return: ${JSON.stringify(result)}`, "result");
  } catch (e) {
    write(`  error: ${(e as Error).message}`, "err");
  }
});

document.getElementById("btn-chat")!.addEventListener("click", async () => {
  sep("WebSocket /chat", "ws");
  const socket = api.chat.$ws();
  await socket.connected;
  write("  connected", "status");

  socket.send({ text: "Hello!" });

  let count = 0;
  for await (const msg of socket) {
    write(`  ${JSON.stringify(msg)}`);
    if (++count >= 2) {
      socket.close();
      break;
    }
  }
  write("  closed", "status");
});
