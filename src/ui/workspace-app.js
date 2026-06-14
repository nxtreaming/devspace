import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps/app-with-deps";
import "./workspace-app.css";

const appRoot = document.querySelector("#app");
let currentResult = null;
let currentPayload = null;
let isExpanded = false;
let isLoading = false;
let loadError = null;

const app = new App(
  { name: "pi-on-mcp-edit-diff", version: "0.1.0" },
  {},
);

app.onhostcontextchanged = (ctx) => {
  if (ctx.theme) applyDocumentTheme(ctx.theme);
  if (ctx.styles?.variables) applyHostStyleVariables(ctx.styles.variables);
  if (ctx.styles?.css?.fonts) applyHostFonts(ctx.styles.css.fonts);
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    document.body.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
  }
};

app.ontoolresult = (result) => {
  const structured = result.structuredContent;
  if (structured?.tool !== "edit_file" || structured?.ui?.card !== "file-diff") {
    renderEmpty("No diff card is available for this tool result.");
    return;
  }

  currentResult = structured;
  currentPayload = null;
  isExpanded = false;
  isLoading = false;
  loadError = null;
  renderCard();
};

app.onteardown = async () => ({});

await app.connect();

function renderEmpty(message) {
  appRoot.innerHTML = "";
  const section = document.createElement("section");
  section.className = "empty";
  section.textContent = message;
  appRoot.append(section);
}

function renderCard() {
  if (!currentResult) {
    renderEmpty("Waiting for an edit result.");
    return;
  }

  const summary = currentResult.summary ?? {};
  const card = document.createElement("section");
  card.className = "diff-card";

  const header = document.createElement("button");
  header.className = "diff-header";
  header.type = "button";
  header.setAttribute("aria-expanded", String(isExpanded));
  header.addEventListener("click", () => {
    isExpanded = !isExpanded;
    renderCard();
    if (isExpanded && !currentPayload && !isLoading) {
      void loadPayload();
    }
  });

  const icon = document.createElement("span");
  icon.className = "file-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "+";

  const path = document.createElement("span");
  path.className = "path";
  path.textContent = String(currentResult.path ?? "edited file");

  const stats = document.createElement("span");
  stats.className = "stats";
  stats.innerHTML = `<span class="add">+${Number(summary.additions ?? 0)}</span> <span class="remove">-${Number(summary.removals ?? 0)}</span>`;

  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.setAttribute("aria-hidden", "true");
  chevron.textContent = isExpanded ? "^" : "v";

  header.append(icon, path, stats, chevron);
  card.append(header);

  if (isExpanded) {
    const body = document.createElement("div");
    body.className = "diff-body";

    if (isLoading) {
      body.append(statusLine("Loading diff..."));
    } else if (loadError) {
      body.append(statusLine(loadError, "error"));
    } else if (currentPayload?.patch || currentPayload?.diff) {
      body.append(renderDiff(currentPayload.patch || currentPayload.diff));
    } else {
      body.append(statusLine("Diff payload is not loaded yet."));
    }

    card.append(body);
  }

  appRoot.innerHTML = "";
  appRoot.append(card);
}

async function loadPayload() {
  isLoading = true;
  loadError = null;
  renderCard();

  try {
    const result = await app.callServerTool({
      name: "get_edit_result_payload",
      arguments: {
        workspaceId: currentResult.workspaceId,
        resultId: currentResult.resultId,
      },
    });

    currentPayload = result.structuredContent?.payload ?? {};
  } catch (error) {
    loadError = error instanceof Error ? error.message : String(error);
  } finally {
    isLoading = false;
    renderCard();
  }
}

function statusLine(text, tone = "muted") {
  const line = document.createElement("div");
  line.className = `status ${tone}`;
  line.textContent = text;
  return line;
}

function renderDiff(diffText) {
  const pre = document.createElement("pre");
  pre.className = "diff";

  for (const line of String(diffText).split("\n")) {
    const row = document.createElement("span");
    row.className = diffLineClass(line);
    row.textContent = line || " ";
    pre.append(row, "\n");
  }

  return pre;
}

function diffLineClass(line) {
  if (line.startsWith("+") && !line.startsWith("+++")) return "line add-line";
  if (line.startsWith("-") && !line.startsWith("---")) return "line remove-line";
  if (line.startsWith("@@")) return "line hunk-line";
  return "line context-line";
}
