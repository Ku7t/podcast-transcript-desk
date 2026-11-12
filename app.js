const form = document.querySelector("#transcribe-form");
const submitButton = document.querySelector("#submit-btn");
const message = document.querySelector("#message");
const steps = [...document.querySelectorAll("[data-step]")];
const summaryOutput = document.querySelector("#summary-output");
const transcriptOutput = document.querySelector("#transcript-output");
const metaOutput = document.querySelector("#meta-output");

let latestResult = null;

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  const url = data.url.trim();
  if (!url) return;

  setBusy(true);
  setStep("link", "active");
  setMessage("收到链接，正在处理。长音频可能需要几分钟。");
  clearResult();

  try {
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url,
        preferYtdlp: Boolean(data.preferYtdlp),
        keepTranscriptStyle: Boolean(data.keepTranscriptStyle),
      }),
    });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || "转写失败。");
    latestResult = payload;
    renderResult(payload);
    completeAllSteps();
    setMessage(payload.warnings?.length ? "完成，但有附加提示，请查看“信息”。" : "完成。摘要和全文都已经生成。");
  } catch (error) {
    setCurrentStep("error");
    setMessage(error.message || "处理失败，请检查链接、API Key 或网络。");
  } finally {
    setBusy(false);
  }
});

document.addEventListener("click", async (event) => {
  const tab = event.target.closest("[data-tab]");
  if (tab) switchTab(tab.dataset.tab);

  const action = event.target.closest("[data-action]")?.dataset.action;
  if (action === "copy") {
    await navigator.clipboard.writeText(latestResult?.transcript || "");
    setMessage("全文已复制。");
  }
  if (action === "download") downloadMarkdown();
});

function setBusy(isBusy) {
  submitButton.disabled = isBusy;
  submitButton.textContent = isBusy ? "正在处理..." : "开始转写";
  form.classList.toggle("working", isBusy);
}

function setMessage(text) {
  message.textContent = text;
}

function clearResult() {
  latestResult = null;
  summaryOutput.className = "empty";
  summaryOutput.textContent = "摘要会显示在这里。";
  transcriptOutput.textContent = "全文文字稿会显示在这里。";
  metaOutput.innerHTML = `
    <div><dt>来源</dt><dd>暂无</dd></div>
    <div><dt>音频</dt><dd>暂无</dd></div>
    <div><dt>模型</dt><dd>暂无</dd></div>
  `;
  steps.forEach((step) => step.classList.remove("active", "done", "error"));
}

function setStep(name, status) {
  const target = steps.find((step) => step.dataset.step === name);
  if (!target) return;
  target.classList.remove("active", "done", "error");
  target.classList.add(status);
}

function setCurrentStep(status) {
  const active = steps.find((step) => step.classList.contains("active")) || steps[0];
  active.classList.add(status);
}

function completeAllSteps() {
  steps.forEach((step) => {
    step.classList.remove("active", "error");
    step.classList.add("done");
  });
}

function renderResult(result) {
  summaryOutput.className = "summary";
  summaryOutput.innerHTML = markdownLite(result.summary);
  transcriptOutput.textContent = result.transcript || "没有获得文字稿。";
  const warnings = (result.warnings || []).filter(Boolean);
  metaOutput.innerHTML = `
    <div><dt>来源</dt><dd>${escapeHtml(result.sourceUrl)}</dd></div>
    <div><dt>音频</dt><dd>${escapeHtml(result.audioUrl || "由页面解析获得")}</dd></div>
    <div><dt>转写模型</dt><dd>${escapeHtml(result.models.transcription)}</dd></div>
    <div><dt>摘要模型</dt><dd>${escapeHtml(result.models.summary)}</dd></div>
    <div><dt>说话人标注</dt><dd>${escapeHtml(result.models.speakerLabeling || "未启用")}</dd></div>
    <div><dt>字数</dt><dd>${result.transcript.length.toLocaleString("zh-CN")} 字符</dd></div>
    ${warnings.length ? `<div><dt>提示</dt><dd>${warnings.map(escapeHtml).join("<br>")}</dd></div>` : ""}
  `;
}

function switchTab(name) {
  document.querySelectorAll("[data-tab]").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  document.querySelectorAll(".view").forEach((view) => view.classList.remove("active"));
  document.querySelector(`#${name}-view`).classList.add("active");
}

function downloadMarkdown() {
  if (!latestResult) return;
  const content = `# 播客转写结果

来源：${latestResult.sourceUrl}

## 摘要

${latestResult.summary}

## 全文

${latestResult.transcript}
`;
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `podcast-transcript-${new Date().toISOString().slice(0, 10)}.md`;
  link.click();
  URL.revokeObjectURL(url);
}

function markdownLite(text) {
  return escapeHtml(text)
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/^### (.*)$/gm, "<h3>$1</h3>")
    .replace(/^## (.*)$/gm, "<h2>$1</h2>")
    .replace(/^- (.*)$/gm, "<li>$1</li>")
    .replace(/((?:<li>.*<\/li>\n?)+)/g, "<ul>$1</ul>")
    .replace(/\n{2,}/g, "</p><p>")
    .replace(/^/, "<p>")
    .replace(/$/, "</p>")
    .replaceAll("<p><h", "<h")
    .replaceAll("</h2></p>", "</h2>")
    .replaceAll("</h3></p>", "</h3>")
    .replaceAll("<p><ul>", "<ul>")
    .replaceAll("</ul></p>", "</ul>");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
