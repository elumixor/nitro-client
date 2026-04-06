const log = document.getElementById("log")!;
let firstEntry = true;

/** Append a styled line to the terminal output. */
export function write(msg: string, cls = "data") {
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

/** Print a section header with a protocol colour. */
export function sep(label: string, protocol: "get" | "post" | "sse" | "ws") {
  if (!firstEntry) {
    const spacer = document.createElement("span");
    spacer.className = "log-spacer";
    log.appendChild(spacer);
  }
  write(label, `header ${protocol}`);
}

/** Reset the terminal to its idle hint state. */
export function clearLog() {
  log.innerHTML = '<span class="log-hint">↑ Click a command to see output</span>';
  firstEntry = true;
}
