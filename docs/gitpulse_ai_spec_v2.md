# GitPulse AI — Tài Liệu Thiết Kế & Kế Hoạch Triển Khai (v2 — Refined)

> **Bối cảnh triển khai:** Ứng dụng **chạy local, một người dùng (self-hosted)**, định hướng **open-source**. Toàn bộ thiết kế dưới đây tối ưu cho đúng mô hình này: đơn giản, không phụ thuộc hạ tầng đám mây bắt buộc, và an toàn-mặc-định cho bất kỳ ai clone repo về chạy.

---

## 0. Nguyên Tắc Thiết Kế (Design Principles)

1. **Local-first:** Chạy được chỉ với `git clone` + `npm install` + `npm run dev`, không bắt buộc dịch vụ cloud nào.
2. **Token không bao giờ vào 2 nơi:** không vào **git repo**, không vào **browser**. Chỉ sống trong tiến trình server local + file `.env` đã `.gitignore`.
3. **YAGNI:** MVP chốt cứng 1 LLM provider, 1 database, 1 luồng. Đa provider/đa DB để lại về sau.
4. **Fail loud, fail safe:** LLM trả JSON hỏng → validate + retry, không render rác. Hết rate limit → báo rõ, không nuốt lỗi.
5. **Open-source hygiene:** repo public phải "sạch" — có `.env.example`, README cảnh báo scope token, không telemetry ẩn.

---

## 1. Tổng Quan Dự Án (Executive Summary)

* **Tên dự án:** GitPulse AI — Personal Project Progress & Planning Dashboard.
* **Mục tiêu:** Web dashboard **self-hosted** kết nối GitHub qua **Personal Access Token (PAT)**, dùng AI để: (1) tóm tắt tiến độ từ commit history, (2) đề xuất next-step có ưu tiên, (3) brainstorm cải tiến kiến trúc — và tạo GitHub Issue bằng 1 click.
* **Pain point cốt lõi (điểm ăn tiền, dồn lực vào đây):**
  * "Mất context" khi quay lại side-project sau nhiều tuần/tháng → cần câu trả lời tức thì cho **"lần trước mình làm tới đâu, giờ nên làm gì tiếp?"**.
  * Cross-repo overview: nhìn nhiều side-project cùng lúc — thứ `git log` và trang GitHub đơn lẻ không cho.
* **Ranh giới (không làm):** không làm lại thứ GitHub đã có tốt (release notes tự sinh cho team, review PR). Không đa người dùng. Không phân tích năng suất/nhân sự.

---

## 2. Kiến Trúc Hệ Thống & Luồng Xử Lý

### 2.1. Luồng Dữ Liệu (End-to-End)

```text
[Browser UI]  ── không bao giờ thấy PAT ──┐
   │ (chỉ gửi: repo cần sync, khoảng thời gian)
   ▼
[Next.js API Routes = Local Server Proxy]  ← PAT đọc từ .env / local config, sống trong RAM server
   │
   ├─→ [GitHub REST API via Octokit]
   │     ├─ GET /user/repos                         (danh sách repo)
   │     ├─ GET /repos/{o}/{r}                       (metadata, default_branch)
   │     ├─ GET /repos/{o}/{r}/compare/{base}...{head}   ← LẤY THAY ĐỔI GỘP (thay cho /commits)
   │     ├─ GET /repos/{o}/{r}/readme
   │     └─ GET /repos/{o}/{r}/issues?state=open
   │
   ▼
[Context Builder & Sanitizer]
   • Loại merge commits, bot commits
   • Ưu tiên: commit messages + danh sách file đổi (A/M/D), diff chỉ đưa khi còn ngân sách token
   • Map-reduce nếu vượt context window
   │
   ▼
[LLM Engine — 1 lần gọi, JSON Mode, validate bằng Zod]
   → { summary, next_steps[], brainstorm_ideas[] }
   │
   ├─→ [Cache: ai_summaries]  (key theo repo + base_sha + head_sha)
   └─→ [action_items]  (insert next_steps + brainstorm_ideas, status='suggested')
   │
   ▼
[Dashboard UI]  ──(1-click, có idempotency)──→ POST /repos/{o}/{r}/issues
                                                → lưu github_issue_id, status='synced'
```

> **Thay đổi quan trọng so với v1:** dùng **Compare API** (`/compare/{base}...{head}`) thay cho `/commits`. Endpoint `/commits` **không trả diff** và tốn N request/N commit (dễ dính rate limit 5000/h). Compare API trả gộp đúng thứ ta cần: "từ lần sync trước → HEAD".

### 2.2. Bảo Mật & Xác Thực (thiết kế cho Local + Open-source)

**Threat model thực tế của app này:**
- ✅ Cần chống: **lỡ commit token lên repo public**; token bị **dependency npm độc** đọc từ browser (supply-chain XSS); token bị **log ra console/file**.
- ❌ Không phải mối lo: cách ly đa người dùng, phiên đăng nhập, CSRF từ người lạ (app chỉ bind `localhost`).

**Quyết định thiết kế:**

| Vấn đề | Cách làm | Lý do |
|---|---|---|
| Token lưu ở đâu | File `.env.local` (đã `.gitignore`), đọc bởi **server** khi khởi động. Có thể thêm trang *Settings* ghi vào file local gitignored. | Local nên `.env` là chuẩn, đơn giản, không cần DB mã hoá/KMS. |
| Token có vào browser không | **Không.** Mọi call GitHub đi qua Next.js API Routes; browser chỉ gọi API nội bộ (`/api/...`). | Loại bỏ hoàn toàn rủi ro `localStorage`/XSS đọc token. Đây mới đúng nghĩa "proxy". |
| Token có vào git không | `.gitignore`: `.env*`, `*.db`, `*.sqlite`, `.gitpulse/`. Kèm `.env.example` chỉ có placeholder. | Bảo vệ người clone repo khỏi tự lộ token. |
| Bind mạng | Server chỉ nghe `127.0.0.1` (không `0.0.0.0`). | Không vô tình phơi ra LAN. |
| Log | Cấm log giá trị token; middleware redact `Authorization` header. | Tránh rò rỉ qua log file khi user share log để báo bug. |
| Scope PAT (tối thiểu, fine-grained) | `Contents: Read-only`, `Metadata: Read-only`, `Issues: Read & Write`, thêm `Pull requests: Read` **chỉ nếu** hiện PR. | Token lộ vẫn giới hạn thiệt hại. README ghi rõ từng scope. |
| LLM key | Cùng cơ chế `.env`, không vào browser, không vào repo. | Đồng nhất với token GitHub. |

> **Ghi chú OSS:** README phải có mục **"Security & Your Token"** giải thích: token ở đâu, scope nào, không gửi đi đâu ngoài `api.github.com` và LLM provider bạn chọn. Minh bạch = niềm tin cho dự án open-source.

---

## 3. Kiến Trúc Dữ Liệu (SQLite — local-first)

> **Chốt chọn:** **SQLite (qua Drizzle ORM)** cho local. File DB `.gitpulse/data.db` (gitignored). Không cần Postgres/Supabase cho 1 người dùng. (Muốn sync nhiều máy sau này thì đổi sang Turso — Drizzle giữ nguyên schema.)

```sql
-- 1. Repository được ghim vào Dashboard
CREATE TABLE projects (
    id            TEXT PRIMARY KEY,              -- uuid sinh ở app
    owner         TEXT NOT NULL,                 -- tách owner/name để gọi API tiện
    repo_name     TEXT NOT NULL,
    repo_url      TEXT NOT NULL,
    default_branch TEXT DEFAULT 'main',
    last_synced_sha TEXT,                        -- HEAD của lần sync gần nhất → làm base cho lần sau
    last_synced_at  INTEGER,                     -- epoch ms
    created_at      INTEGER NOT NULL,
    UNIQUE(owner, repo_name)
);

-- 2. Cache kết quả AI (tránh gọi lại LLM tốn token)
CREATE TABLE ai_summaries (
    id          TEXT PRIMARY KEY,
    project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    base_sha    TEXT NOT NULL,                   -- điểm đầu khoảng so sánh
    head_sha    TEXT NOT NULL,                   -- điểm cuối
    summary_json TEXT NOT NULL,                  -- JSON đã validate (cả 3 khối trong 1 lần gọi)
    model       TEXT,                            -- model đã dùng, để trace
    created_at  INTEGER NOT NULL,
    UNIQUE(project_id, base_sha, head_sha)       -- cache key rõ ràng
);

-- 3. Action Items & Ideas do AI sinh ra
CREATE TABLE action_items (
    id           TEXT PRIMARY KEY,
    project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    summary_id   TEXT REFERENCES ai_summaries(id) ON DELETE SET NULL,  -- truy nguồn item từ lần phân tích nào
    source       TEXT NOT NULL,                  -- 'next_step' | 'brainstorm'
    title        TEXT NOT NULL,
    description  TEXT,
    category     TEXT,                           -- 'feature'|'bug'|'refactor'|'architecture'|'performance'|'enhancement'
    priority     TEXT DEFAULT 'medium',          -- 'high'|'medium'|'low'
    status       TEXT DEFAULT 'suggested',       -- 'suggested'|'approved'|'synced'|'dismissed'
    github_issue_number INTEGER,                 -- issue NUMBER (dùng để build URL), không phải internal id
    github_issue_url    TEXT,
    created_at   INTEGER NOT NULL
);
```

**Sửa so với v1:**
- `ai_summaries` thêm `mode` → thực ra **gộp cả 3 khối vào 1 lần gọi LLM** nên chỉ cần 1 record/khoảng SHA (rẻ hơn 3 lần gọi). `UNIQUE(project_id, base_sha, head_sha)` chống cache trùng.
- `action_items` thêm `source` + `summary_id` để **map rõ** output LLM (`next_steps`/`brainstorm_ideas`) vào bảng — v1 bị đứt mối nối này.
- Lưu `github_issue_number` (không phải `issue_id` nội bộ) vì đó là thứ dựng được URL `.../issues/{number}`.
- `projects.last_synced_sha` = chìa khoá cho luồng incremental: lần sau `compare` từ SHA này → HEAD.

---

## 4. Đặc Tả Giao Diện Dashboard

**A. Hub / Overview**
- Grid cards mỗi repo: last commit (msg + thời gian tương đối), tech stack detect (từ ngôn ngữ repo + file manifest), số open issues, badge "N thay đổi chưa phân tích" nếu HEAD ≠ `last_synced_sha`.
- Nút **Sync now** trên từng card + nút **Sync all**.

**B. Project Workspace (3 cột)**
- **Cột 1 — Git Activity:** commit list (từ compare), lọc theo thời gian/author; hiện file changed. (PR list để Giai đoạn 2.)
- **Cột 2 — AI Core Insights:**
  - *What Was Built* — `key_achievements`, `fixes_and_refactoring`, `architectural_changes`.
  - *Next Sprint Plan* — 3–5 việc, mỗi việc có badge priority + type.
- **Cột 3 — Idea & Brainstorm Lab:** ý tưởng kiến trúc/performance; mỗi card có nút **Push to GitHub Issue**.

**Trạng thái bắt buộc xử lý (v1 thiếu):**
- Repo chưa có commit / không có thay đổi từ lần sync trước → empty state "Chưa có gì mới".
- LLM trả JSON hỏng → báo "Phân tích lỗi, thử lại" + nút retry.
- Hết rate limit GitHub → hiện thời điểm reset.
- Đang gọi LLM → skeleton loading (có thể mất vài giây).

**Idempotency nút "Push to Issue" (v1 thiếu):**
- Nút chỉ enable khi `status ∈ {suggested, approved}`.
- Sau POST thành công: lưu `github_issue_number` + `github_issue_url`, đổi `status='synced'`, đổi nút thành link "View Issue #N".
- Bấm khi đang gửi → disable để tránh double-submit tạo issue trùng.

---

## 5. Prompt Engineering & LLM Spec

**Nguyên tắc:** 1 lần gọi trả cả 3 khối; ép JSON mode/structured output; **validate bằng Zod** ở server; hỏng thì retry 1 lần với chỉ dẫn sửa format, vẫn hỏng thì trả lỗi UI.

### 5.1. System Prompt (rút gọn, ổn định)
```text
Bạn là Technical Lead phân tích một repository Git cá nhân.
Đầu vào: commit messages + danh sách file thay đổi (có thể kèm diff rút gọn),
nội dung README, và danh sách issue đang mở.
Chỉ trả về JSON hợp lệ đúng schema dưới. Không thêm chữ ngoài JSON.
Nếu thông tin không đủ, để mảng rỗng thay vì bịa.

Schema:
{
  "summary": {
    "key_achievements": [string],
    "fixes_and_refactoring": [string],
    "architectural_changes": [string]
  },
  "next_steps": [
    { "title": string, "description": string,
      "priority": "high"|"medium"|"low",
      "type": "feature"|"bug"|"refactor" }
  ],
  "brainstorm_ideas": [
    { "title": string,
      "category": "architecture"|"enhancement"|"performance",
      "rationale": string }
  ]
}
```

### 5.2. Context budget (chống tràn token)
- Bậc 1: commit messages + file list + README (thường đủ).
- Bậc 2: nếu còn ngân sách → thêm diff các file "quan trọng" (loại lock files, `dist/`, ảnh).
- Bậc 3 (repo lớn): map-reduce — tóm tắt theo lô ~20 commit rồi tổng hợp lần cuối.

---

## 6. Lộ Trình Phát Triển (Refined)

**MVP thu gọn — mục tiêu: có thứ chạy được sớm nhất**
- `.env` + server proxy đọc PAT (không browser, không repo).
- Kết nối 1 repo → **Compare API** lấy thay đổi từ `last_synced_sha`→HEAD (lần đầu: N commit gần nhất).
- 1 lần gọi LLM → 3 khối JSON → **validate Zod** → render 3 cột.
- Nút tạo Issue **có idempotency**.
- Bỏ qua tạm: multi-repo hub, cache DB, PR view.

**Giai đoạn 2 — Hoàn thiện dashboard**
- Multi-repo Hub + Sync all.
- Cache `ai_summaries` (tiết kiệm token), lưu `action_items`.
- Lọc commit theo thời gian/tag version; hiện PR list.

**Giai đoạn 3 — Tự động hoá nhẹ (giữ đúng tinh thần local)**
- Quét inline `// TODO:` / `// FIXME:` trong code → gom vào Brainstorm Lab.
- **Polling / "Sync on open"** thay cho Webhook. *(Webhook cần endpoint public + verify signature + retry — quá nặng và phá vỡ mô hình local; bỏ.)*
- Xuất changelog `.md` theo tag version.
- *(Tuỳ chọn xa)* GitHub App/OAuth — chỉ khi muốn biến thành SaaS đa người dùng; ngoài phạm vi bản này.

---

## 7. Tech Stack (chốt cứng cho MVP)

* **Framework:** Next.js 14+ (App Router) + TypeScript. API Routes làm proxy.
* **UI:** Tailwind CSS + shadcn/ui + Lucide.
* **GitHub client:** `@octokit/rest`.
* **AI:** **chọn 1** provider cho MVP (khuyến nghị một cái có structured-output/JSON mode tốt). Không abstract đa provider ở v1.
* **DB/ORM:** **SQLite + Drizzle ORM** (file local). Đổi sang Turso về sau nếu cần, schema giữ nguyên.
* **Validation:** **Zod** cho mọi output LLM và input API.
* **Chạy:** `npm run dev`, server bind `127.0.0.1`.

---

## 8. Checklist Trước Khi Public Repo (OSS)

- [ ] `.gitignore` chứa `.env*`, `*.db`, `*.sqlite`, `.gitpulse/`.
- [ ] Có `.env.example` chỉ placeholder (không giá trị thật).
- [ ] `git log -p` / `git secrets` xác nhận **chưa từng** commit token.
- [ ] README có mục "Security & Your Token": nơi lưu, scope tối thiểu, không gửi đi đâu ngoài GitHub + LLM.
- [ ] Middleware redact `Authorization` khỏi log.
- [ ] Server chỉ bind localhost, ghi rõ trong README.
- [ ] LICENSE (MIT/Apache-2.0) + hướng dẫn 3 bước chạy local.
