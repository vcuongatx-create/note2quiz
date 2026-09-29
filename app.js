// ============ CONFIG ============
const GEMINI_MODEL = "gemini-2.0-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

pdfjsLib.GlobalWorkerOptions.workerSrc =
  "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

// ============ STATE ============
let currentQuiz = null;   // { title, questions: [{question, options, correctIndex, explanation, topic}] }
let userAnswers = {};     // { qIndex: selectedOptionIndex }

// ============ API KEY ============
function getApiKey() {
  return localStorage.getItem("gemini_api_key") || "";
}

document.getElementById("saveKeyBtn").addEventListener("click", () => {
  const key = document.getElementById("apiKeyInput").value.trim();
  if (!key) return showStatus("keyStatus", "Vui lòng nhập key", "error");
  localStorage.setItem("gemini_api_key", key);
  showStatus("keyStatus", "✅ Đã lưu API key", "success");
});

// Load key khi mở trang
window.addEventListener("DOMContentLoaded", () => {
  const key = getApiKey();
  if (key) document.getElementById("apiKeyInput").value = key;
});

// ============ TAB SWITCHING ============
document.querySelectorAll(".nav-btn").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    btn.classList.add("active");
    document.getElementById("tab-" + btn.dataset.tab).classList.add("active");
  });
});

// ============ UTILS ============
function showStatus(id, msg, type = "info") {
  const el = document.getElementById(id);
  el.textContent = msg;
  el.className = "status " + type;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}

async function callGemini(prompt, retries = 2) {
  const key = getApiKey();
  if (!key) throw new Error("Chưa có API key. Vào tab ⚙️ API để nhập.");

  const body = {
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 4096 }
  };

  for (let i = 0; i <= retries; i++) {
    try {
      const res = await fetch(`${GEMINI_URL}?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const err = await res.text();
        throw new Error(`Gemini API lỗi (${res.status}): ${err.slice(0, 200)}`);
      }
      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Không nhận được phản hồi từ AI.");
      return text;
    } catch (e) {
      if (i === retries) throw e;
      await new Promise(r => setTimeout(r, 1500));
    }
  }
}

function parseJsonLoose(text) {
  // Bỏ code fence ```json ... ```
  let cleaned = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  // Tìm JSON object lớn nhất
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first === -1 || last === -1) throw new Error("Không tìm thấy JSON trong phản hồi AI.");
  cleaned = cleaned.slice(first, last + 1);
  return JSON.parse(cleaned);
}

// ============ FILE PARSING ============
async function extractTextFromFile(file) {
  const name = file.name.toLowerCase();

  if (name.endsWith(".txt") || name.endsWith(".md")) {
    return await file.text();
  }

  if (name.endsWith(".pdf")) {
    const buf = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
    let out = "";
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      out += content.items.map(it => it.str).join(" ") + "\n";
    }
    return out;
  }

  if (name.endsWith(".docx")) {
    const buf = await file.arrayBuffer();
    const result = await mammoth.extractRawText({ arrayBuffer: buf });
    return result.value;
  }

  if (/\.(png|jpe?g|webp)$/.test(name)) {
    // Ảnh: dùng Gemini Vision (OCR)
    const base64 = await fileToBase64(file);
    return await ocrWithGemini(base64, file.type);
  }

  throw new Error("Định dạng không hỗ trợ: " + name);
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function ocrWithGemini(base64, mimeType) {
  const key = getApiKey();
  if (!key) throw new Error("Cần API key để đọc ảnh.");

  const body = {
    contents: [{
      parts: [
        { text: "Trích xuất TOÀN BỘ văn bản trong ảnh này (OCR), giữ nguyên nội dung, không thêm bình luận." },
        { inline_data: { mime_type: mimeType, data: base64 } }
      ]
    }]
  };

  const res = await fetch(`${GEMINI_URL}?key=${key}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body)
  });
  if (!res.ok) throw new Error("OCR lỗi: " + (await res.text()).slice(0, 200));
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// ============ GENERATE QUIZ ============
document.getElementById("generateBtn").addEventListener("click", generateQuiz);

async function generateQuiz() {
  const btn = document.getElementById("generateBtn");
  const status = document.getElementById("generateStatus");
  btn.disabled = true;
  btn.innerHTML = '<span class="loader"></span>Đang phân tích...';
  showStatus("generateStatus", "⏳ Đang xử lý tài liệu...", "info");

  try {
    const numQ = parseInt(document.getElementById("numQuestions").value) || 10;
    const difficulty = document.getElementById("difficulty").value;
    const language = document.getElementById("language").value;

    // 1. Thu thập nội dung
    let sourceText = "";
    const files = document.getElementById("fileInput").files;
    const pasted = document.getElementById("pasteInput").value.trim();
    const topic = document.getElementById("topicInput").value.trim();

    if (files.length > 0) {
      showStatus("generateStatus", `⏳ Đang đọc ${files.length} file...`, "info");
      for (const f of files) {
        try {
          const t = await extractTextFromFile(f);
          sourceText += `\n\n### File: ${f.name}\n${t}`;
        } catch (e) {
          console.warn("Lỗi đọc file", f.name, e);
        }
      }
    }

    if (pasted) sourceText += `\n\n### Văn bản dán:\n${pasted}`;

    if (!sourceText && !topic) {
      throw new Error("Vui lòng upload file, dán văn bản, hoặc nhập chủ đề.");
    }

    showStatus("generateStatus", "🤖 AI đang tạo đề...", "info");

    // 2. Build prompt
    const contextPart = sourceText
      ? `DỮ LIỆU NGUỒN:\n${sourceText.slice(0, 25000)}`
      : `CHỦ ĐỀ CẦN TRA: ${topic}\nHãy tự sử dụng kiến thức của bạn để tạo đề về chủ đề này.`;

    const prompt = `Bạn là giáo viên chuyên ra đề kiểm tra. Nhiệm vụ: tạo bài trắc nghiệm dựa trên dữ liệu dưới đây.

${contextPart}

YÊU CẦU:
- Tạo đúng ${numQ} câu hỏi trắc nghiệm, độ khó: ${difficulty}.
- Ngôn ngữ: ${language}.
- Mỗi câu có 4 lựa chọn (A/B/C/D), 1 đáp án đúng.
- Mỗi câu phải có "explanation" giải thích tại sao đáp án đúng.
- Mỗi câu gán 1 "topic" (chủ đề con ngắn gọn 2-5 từ) để phân tích điểm yếu.
- Trả về DUY NHẤT JSON đúng định dạng sau, KHÔNG bọc trong \`\`\`:

{
  "title": "Tiêu đề bài kiểm tra ngắn gọn",
  "questions": [
    {
      "question": "Nội dung câu hỏi?",
      "options": ["Đáp án A", "Đáp án B", "Đáp án C", "Đáp án D"],
      "correctIndex": 0,
      "explanation": "Giải thích chi tiết tại sao đáp án đúng.",
      "topic": "Tên chủ đề con"
    }
  ]
}`;

    const raw = await callGemini(prompt);
    const quiz = parseJsonLoose(raw);

    if (!quiz.questions || !Array.isArray(quiz.questions) || quiz.questions.length === 0) {
      throw new Error("AI không trả về câu hỏi nào.");
    }

    currentQuiz = quiz;
    userAnswers = {};
    renderQuiz();
    showStatus("generateStatus", `✅ Đã tạo ${quiz.questions.length} câu hỏi!`, "success");

    // Chuyển tab quiz
    document.querySelector('[data-tab="quiz"]').click();

  } catch (e) {
    console.error(e);
    showStatus("generateStatus", "❌ " + e.message, "error");
  } finally {
    btn.disabled = false;
    btn.innerHTML = "✨ Tạo đề ngay";
  }
}

// ============ RENDER QUIZ ============
function renderQuiz() {
  document.getElementById("quizEmpty").style.display = "none";
  document.getElementById("quizContainer").style.display = "block";
  document.getElementById("quizTitle").textContent = currentQuiz.title || "Bài kiểm tra";
  document.getElementById("resultCard").style.display = "none";
  document.getElementById("retryBtn").style.display = "none";
  document.getElementById("checkBtn").style.display = "block";
  document.getElementById("checkBtn").disabled = false;
  document.getElementById("checkBtn").textContent = "✅ Check đáp án";

  const list = document.getElementById("questionsList");
  list.innerHTML = "";

  currentQuiz.questions.forEach((q, i) => {
    const div = document.createElement("div");
    div.className = "question";
    div.dataset.index = i;
    div.innerHTML = `
      <div class="question-text">Câu ${i + 1}: ${escapeHtml(q.question)}</div>
      ${q.options.map((opt, j) => `
        <label class="option" data-q="${i}" data-o="${j}">
          <input type="radio" name="q${i}" value="${j}" data-q="${i}" data-o="${j}" />
          <span>${String.fromCharCode(65 + j)}. ${escapeHtml(opt)}</span>
        </label>
      `).join("")}
      <div class="explanation" id="exp-${i}"></div>
    `;
    list.appendChild(div);
  });

  // Event listener chọn đáp án
  list.querySelectorAll('input[type="radio"]').forEach(input => {
    input.addEventListener("change", e => {
      const qIdx = parseInt(e.target.dataset.q);
      const oIdx = parseInt(e.target.dataset.o);
      userAnswers[qIdx] = oIdx;
      // Update UI
      list.querySelectorAll(`.option[data-q="${qIdx}"]`).forEach(o => o.classList.remove("selected"));
      list.querySelector(`.option[data-q="${qIdx}"][data-o="${oIdx}"]`).classList.add("selected");
      updateProgress();
    });
  });

  updateProgress();
}

function updateProgress() {
  const total = currentQuiz.questions.length;
  const done = Object.keys(userAnswers).length;
  document.getElementById("progressText").textContent = `${done}/${total}`;
  document.getElementById("progressFill").style.width = `${(done / total) * 100}%`;
}

// ============ CHECK ANSWERS ============
document.getElementById("checkBtn").addEventListener("click", () => {
  if (!currentQuiz) return;

  const total = currentQuiz.questions.length;
  const answered = Object.keys(userAnswers).length;

  if (answered < total) {
    if (!confirm(`Bạn mới làm ${answered}/${total} câu. Vẫn check?`)) return;
  }

  let correct = 0;
  const topicStats = {}; // { topic: {correct, total} }

  currentQuiz.questions.forEach((q, i) => {
    const chosen = userAnswers[i];
    const isCorrect = chosen === q.correctIndex;

    // Topic stats
    const t = q.topic || "Khác";
    if (!topicStats[t]) topicStats[t] = { correct: 0, total: 0 };
    topicStats[t].total++;
    if (isCorrect) {
      correct++;
      topicStats[t].correct++;
    }

    // Update UI
    const qDiv = document.querySelector(`.question[data-index="${i}"]`);
    qDiv.classList.remove("correct", "wrong");
    qDiv.classList.add(isCorrect ? "correct" : "wrong");

    qDiv.querySelectorAll(".option").forEach(optEl => {
      const oIdx = parseInt(optEl.dataset.o);
      optEl.classList.remove("correct-answer", "wrong-answer");
      optEl.querySelector("input").disabled = true;

      if (oIdx === q.correctIndex) {
        optEl.classList.add("correct-answer");
      }
      if (oIdx === chosen && !isCorrect) {
        optEl.classList.add("wrong-answer");
      }
    });

    // Explanation
    const exp = document.getElementById(`exp-${i}`);
    exp.classList.add("show");
    exp.innerHTML = `
      <b>${isCorrect ? "✅ Đúng!" : "❌ Sai."}</b>
      Đáp án đúng: <b>${String.fromCharCode(65 + q.correctIndex)}. ${escapeHtml(q.options[q.correctIndex])}</b><br/>
      <b>Giải thích:</b> ${escapeHtml(q.explanation || "")}
    `;
  });

  const percent = Math.round((correct / total) * 100);
  showResults(correct, total, percent, topicStats);

  // UI đổi nút
  document.getElementById("checkBtn").style.display = "none";
  document.getElementById("retryBtn").style.display = "block";

  // Scroll tới kết quả
  document.getElementById("resultCard").scrollIntoView({ behavior: "smooth" });
});

function showResults(correct, total, percent, topicStats) {
  const card = document.getElementById("resultCard");
  card.style.display = "block";

  // Score
  let color = percent >= 80 ? "var(--success)" : percent >= 50 ? "var(--warning)" : "var(--danger)";
  let comment = percent >= 80 ? "🎉 Xuất sắc!" : percent >= 50 ? "💪 Khá ổn, cần cố thêm!" : "📖 Cần ôn lại nhiều đó!";

  document.getElementById("scoreDisplay").innerHTML = `
    <div style="color:${color}">${percent}%</div>
    <small>${correct}/${total} câu đúng — ${comment}</small>
  `;

  // Analysis
  const analysisBox = document.getElementById("analysisBox");
  analysisBox.innerHTML = `
    <b>📊 Phân tích tổng quan:</b><br/>
    Bạn trả lời đúng <b>${correct}</b>/${total} câu (${percent}%).<br/>
    ${
      percent >= 80
        ? "Bạn nắm khá vững kiến thức. Hãy thử độ khó cao hơn!"
        : percent >= 50
        ? "Bạn hiểu cơ bản nhưng còn lỗ hổng. Xem phần chủ đề yếu bên dưới."
        : "Bạn cần ôn lại từ đầu. Đọc lại tài liệu và làm lại quiz."
    }
  `;

  // Weak topics
  const weakTopicsBox = document.getElementById("weakTopicsBox");
  const weakTopics = Object.entries(topicStats)
    .filter(([_, s]) => s.correct / s.total < 0.7)
    .sort((a, b) => a[1].correct / a[1].total - b[1].correct / b[1].total);

  if (weakTopics.length === 0) {
    weakTopicsBox.innerHTML = `<b>✅ Không có chủ đề yếu</b> — Bạn nắm tốt tất cả phần!`;
    weakTopicsBox.style.background = "#d1fae5";
    weakTopicsBox.style.borderLeftColor = "var(--success)";
  } else {
    weakTopicsBox.style.background = "#fef3c7";
    weakTopicsBox.style.borderLeftColor = "var(--warning)";
    weakTopicsBox.innerHTML = `
      <b>⚠️ Chủ đề bạn đang YẾU (cần ôn lại):</b><br/><br/>
      ${weakTopics.map(([topic, s]) => `
        <div style="margin-bottom:8px">
          <span class="topic-tag">${escapeHtml(topic)}</span>
          Đúng ${s.correct}/${s.total} câu (${Math.round(s.correct / s.total * 100)}%)
        </div>
      `).join("")}
      <br/><b>💡 Gợi ý:</b> Đọc lại phần tài liệu liên quan tới các chủ đề trên, rồi bấm "Làm lại" để kiểm tra.
    `;
  }
}

// Retry
document.getElementById("retryBtn").addEventListener("click", () => {
  if (!currentQuiz) return;
  userAnswers = {};
  renderQuiz();
  window.scrollTo({ top: 0, behavior: "smooth" });
});

// ============ CHAT ============
document.getElementById("chatSendBtn").addEventListener("click", sendChat);
document.getElementById("chatInput").addEventListener("keydown", e => {
  if (e.key === "Enter") sendChat();
});

async function sendChat() {
  const input = document.getElementById("chatInput");
  const text = input.value.trim();
  if (!text) return;

  input.value = "";
  appendMsg(text, "user");

  const loadingId = "loading-" + Date.now();
  appendMsg(`<span class="loader"></span>Đang suy nghĩ...`, "bot", loadingId);

  try {
    const prompt = `Bạn là gia sư thông minh. Trả lời câu hỏi sau bằng tiếng Việt, ngắn gọn, dễ hiểu, có ví dụ nếu cần:\n\n${text}`;
    const reply = await callGemini(prompt);
    document.getElementById(loadingId).remove();
    appendMsg(reply, "bot");
  } catch (e) {
    document.getElementById(loadingId)?.remove();
    appendMsg("❌ Lỗi: " + e.message, "bot");
  }
}

function appendMsg(html, role, id = null) {
  const box = document.getElementById("chatMessages");
  const div = document.createElement("div");
  div.className = "msg " + role;
  if (id) div.id = id;
  div.innerHTML = html;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}