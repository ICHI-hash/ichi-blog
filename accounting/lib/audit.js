'use strict';
/**
 * accounting/lib/audit.js
 * リポジトリの実ファイルから事実ベースで自動化棚卸しレポートを生成する。
 * AI による推測は最小限。不明な場合は "(README に未記載)" を返す。
 */
const fs   = require('fs');
const path = require('path');

require('dotenv').config({ path: path.resolve(__dirname, '../../.env') });

const REPO_ROOT = path.resolve(__dirname, '../..');

// ------------------------------------------------------------------ helpers

function readJson(filepath) {
  try { return JSON.parse(fs.readFileSync(filepath, 'utf8')); } catch { return null; }
}
function readText(filepath) {
  try { return fs.readFileSync(filepath, 'utf8'); } catch { return ''; }
}
function safeReadDir(dir) {
  try { return fs.readdirSync(dir).filter(f => !f.startsWith('.')); } catch { return []; }
}

function toJSTISOString() {
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().replace('Z', '+09:00');
}

// yaml を最小限にパース(スケジュール cron と on の抽出のみ)
function extractCron(yamlText) {
  const m = yamlText.match(/cron:\s+"([^"]+)"/);
  return m ? m[1] : null;
}
function hasTrigger(yamlText, trigger) {
  return yamlText.includes(trigger);
}
function extractSecrets(yamlText) {
  const matches = [...yamlText.matchAll(/secrets\.([A-Z_]+)/g)];
  return [...new Set(matches.map(m => m[1]))].sort();
}

// ------------------------------------------------------------------ script metadata (事実ベース、README + コメントから構築)

const SCRIPT_META = {
  // ── marketing ──
  'generate': {
    dept: 'marketing',
    purpose: '週次コンテンツ (X 投稿・note 記事) の自動生成',
    ai_used: true,
    ai_role: 'Claude が X 投稿文・note 記事案を生成',
    state_writes: false,
    human_judgment: 'Notion 上での内容確認・修正。自動投稿前の承認フローなし',
    data_location: 'ichi-blog',
    automation_class: 'ai_assisted',
  },
  'post-x': {
    dept: 'marketing',
    purpose: '生成済みドラフトを X (Twitter) に自動投稿',
    ai_used: false,
    ai_role: null,
    state_writes: false,
    human_judgment: '投稿ドラフトの事前確認 (generate 実行時)',
    data_location: 'ichi-blog',
    automation_class: 'fully_automated',
  },
  'notion': {
    dept: 'marketing',
    purpose: '生成コンテンツを Notion DB に公開',
    ai_used: false,
    ai_role: null,
    state_writes: false,
    human_judgment: 'Notion 上での最終確認・修正',
    data_location: 'ichi-blog',
    automation_class: 'fully_automated',
  },
  // ── sales ──
  'sales:reminder': {
    dept: 'sales',
    purpose: '営業パイプラインの要対応案件を毎朝 Gmail で通知',
    ai_used: false,
    ai_role: null,
    state_writes: false,
    human_judgment: 'パイプライン案件の入力・ステージ更新（手動）',
    data_location: 'ichi-data',
    automation_class: 'fully_automated',
  },
  // ── engineering ──
  'new-project': {
    dept: 'engineering',
    purpose: '新プロジェクトのディレクトリ雛形・README・GitHub Issue を生成',
    ai_used: true,
    ai_role: 'Claude が README・Issue 本文・初期コードを生成',
    state_writes: false,
    human_judgment: '生成物のレビューと修正',
    data_location: 'ichi-blog',
    automation_class: 'ai_assisted',
  },
  'gen:test': {
    dept: 'engineering',
    purpose: '指定ソースファイルのユニットテストを AI 生成',
    ai_used: true,
    ai_role: 'Claude がテストケースを生成',
    state_writes: false,
    human_judgment: '生成テストのレビュー・修正・CI 追加',
    data_location: 'ichi-blog',
    automation_class: 'ai_assisted',
  },
  'gen:docs': {
    dept: 'engineering',
    purpose: 'ソースコードから API ドキュメントを AI 生成',
    ai_used: true,
    ai_role: 'Claude がドキュメント文字列・API 説明を生成',
    state_writes: false,
    human_judgment: '生成ドキュメントのレビュー',
    data_location: 'ichi-blog',
    automation_class: 'ai_assisted',
  },
  'triage': {
    dept: 'engineering',
    purpose: 'GitHub Issue を AI で自動トリアージ・ラベリング',
    ai_used: true,
    ai_role: 'Claude が Issue を分析してラベル・優先度を提案',
    state_writes: false,
    human_judgment: '提案されたラベルの確認と適用',
    data_location: 'ichi-blog',
    automation_class: 'ai_assisted',
  },
  'smoke:eng': {
    dept: 'engineering',
    purpose: 'engineering スクリプト群のスモークテスト実行',
    ai_used: false,
    ai_role: null,
    state_writes: false,
    human_judgment: 'テスト失敗時の対応',
    data_location: 'ichi-blog',
    automation_class: 'fully_automated',
  },
  // ── planning ──
  'gen:requirements': {
    dept: 'planning',
    purpose: '案件の要件定義書を Claude で自動生成',
    ai_used: true,
    ai_role: 'Claude が要件定義文書を生成',
    state_writes: false,
    human_judgment: '要件の確認・修正・承認',
    data_location: 'ichi-blog',
    automation_class: 'ai_assisted',
  },
  'estimate': {
    dept: 'planning',
    purpose: '案件の工数見積もりを AI で生成',
    ai_used: true,
    ai_role: 'Claude が過去実績参照で工数を推定',
    state_writes: false,
    human_judgment: '見積もりの確認・最終承認',
    data_location: 'ichi-blog',
    automation_class: 'ai_assisted',
  },
  'research': {
    dept: 'planning',
    purpose: '技術・市場調査レポートを AI で自動生成',
    ai_used: true,
    ai_role: 'Claude が調査内容を整理・要約',
    state_writes: false,
    human_judgment: '調査内容の確認・追加',
    data_location: 'ichi-blog',
    automation_class: 'ai_assisted',
  },
  'roadmap': {
    dept: 'planning',
    purpose: 'プロジェクトロードマップを AI で自動生成',
    ai_used: true,
    ai_role: 'Claude がマイルストーン・優先度を提案',
    state_writes: false,
    human_judgment: 'ロードマップの確認・調整',
    data_location: 'ichi-blog',
    automation_class: 'ai_assisted',
  },
  'dashboard': {
    dept: 'planning',
    purpose: 'プロジェクト進捗ダッシュボードを自動生成',
    ai_used: true,
    ai_role: 'Claude が進捗サマリを分析・記述',
    state_writes: false,
    human_judgment: '進捗データの入力・確認',
    data_location: 'ichi-blog',
    automation_class: 'ai_assisted',
  },
  'weekly-report': {
    dept: 'planning',
    purpose: '週次進捗レポートを AI で自動生成・Notion 投稿',
    ai_used: true,
    ai_role: 'Claude が週次サマリを生成',
    state_writes: false,
    human_judgment: 'レポートの確認・修正',
    data_location: 'ichi-blog',
    automation_class: 'ai_assisted',
  },
  // ── accounting ──
  'invoice': {
    dept: 'accounting',
    purpose: '請求書 PDF の自動生成・採番管理・インボイス対応',
    ai_used: false,
    ai_role: null,
    state_writes: true,
    human_judgment: '発行前の内容確認・npm run invoice 実行判断',
    data_location: 'ichi-data',
    automation_class: 'fully_automated',
  },
  'categorize': {
    dept: 'accounting',
    purpose: '銀行・カード CSV を AI で勘定科目別に仕訳',
    ai_used: true,
    ai_role: 'Claude が勘定科目を推定 (confidence 付き)',
    state_writes: true,
    human_judgment: '信頼度 0.7 未満の要確認エントリ修正、最終仕訳確定は税理士',
    data_location: 'ichi-data',
    automation_class: 'ai_assisted',
  },
  'reconcile': {
    dept: 'accounting',
    purpose: '銀行入金と請求書の消込候補をスコアリングで提案',
    ai_used: true,
    ai_role: '振込人名と顧客名の類似度を AI が補正 (Jaro-Winkler + Claude)',
    state_writes: true,
    human_judgment: '消込候補の確認・--confirm による確定。AI 自動確定条件 (score≥0.95) 未満は人が判断',
    data_location: 'ichi-data',
    automation_class: 'ai_assisted',
  },
  'payments': {
    dept: 'accounting',
    purpose: '支払期日が近い payable を検出して Gmail でリマインダー送信',
    ai_used: false,
    ai_role: null,
    state_writes: true,
    human_judgment: 'payable ファイルへのデータ入力、実際の支払操作は銀行アプリで人が実施',
    data_location: 'ichi-data',
    automation_class: 'fully_automated',
  },
  'monthly-report': {
    dept: 'accounting',
    purpose: '月次レポート (売上・経費・推定納税額) の自動生成・Notion 投稿',
    ai_used: false,
    ai_role: null,
    state_writes: false,
    human_judgment: 'レポートの最終確認。推定納税額は概算のため税理士確認必須',
    data_location: 'ichi-data',
    automation_class: 'fully_automated',
  },
  'tax-package': {
    dept: 'accounting',
    purpose: '税理士提出用の月次パッケージ (PDF・CSV・チェックリスト) を生成',
    ai_used: false,
    ai_role: null,
    state_writes: false,
    human_judgment: 'checklist.md の確認、不足領収書の追加配置、税理士への送付は人が実施',
    data_location: 'ichi-data',
    automation_class: 'fully_automated',
  },
  'fetch-receipts': {
    dept: 'accounting',
    purpose: 'Gmail から領収書メールを検出・添付ダウンロード・Claude OCR でメタデータ抽出',
    ai_used: true,
    ai_role: 'Claude が領収書 PDF/画像から取引先・金額・日付を OCR 抽出 (needs_review 付き)',
    state_writes: true,
    human_judgment: 'needs_review=true のエントリ確認、OCR 結果の修正',
    data_location: 'ichi-data',
    automation_class: 'ai_assisted',
  },
  'sync-from-sales': {
    dept: 'accounting',
    purpose: '営業パイプラインで受注になった案件から経理の請求書下書きを自動生成',
    ai_used: true,
    ai_role: 'Claude が品目名と支払条件文を整形 (金額は推定しない)',
    state_writes: true,
    human_judgment: '下書きの確認・金額入力・npm run invoice による PDF 最終発行',
    data_location: 'ichi-data',
    automation_class: 'ai_assisted',
  },
  'tax-rates-check': {
    dept: 'accounting',
    purpose: '税率設定の年次チェックリスト生成 (Markdown / JSON)',
    ai_used: false,
    ai_role: null,
    state_writes: false,
    human_judgment: '国税庁・財務省の改正情報との照合・税率ファイルの更新',
    data_location: 'ichi-blog',
    automation_class: 'fully_automated',
  },
};

// ------------------------------------------------------------------ workflow metadata

function parseWorkflows() {
  const dir = path.resolve(REPO_ROOT, '.github/workflows');
  const files = safeReadDir(dir).filter(f => f.endsWith('.yml'));
  return files.map(file => {
    const text    = readText(path.resolve(dir, file));
    const cron    = extractCron(text);
    const hasSch  = Boolean(cron);
    const hasDsp  = hasTrigger(text, 'workflow_dispatch');
    const trigger = hasSch && hasDsp ? 'both' : hasSch ? 'schedule' : hasDsp ? 'dispatch_only' : 'other';
    const secrets = extractSecrets(text);
    const usesData   = text.includes('checkout-data-repo');
    const commitsData = text.includes('commit-data-changes');

    return {
      file:              `.github/workflows/${file}`,
      cron:              cron || null,
      trigger,
      uses_data_repo:    usesData,
      commits_to_data_repo: commitsData,
      secrets_required:  secrets,
    };
  });
}

// ------------------------------------------------------------------ repo state

function buildRepoState() {
  const pkg      = readJson(path.resolve(REPO_ROOT, 'package.json')) || {};
  const scripts  = Object.keys(pkg.scripts || {});
  const wfDir    = path.resolve(REPO_ROOT, '.github/workflows');
  const wfFiles  = safeReadDir(wfDir).filter(f => f.endsWith('.yml'));
  const actDir   = path.resolve(REPO_ROOT, '.github/actions');
  const actFiles = safeReadDir(actDir);
  const gitignore = readText(path.resolve(REPO_ROOT, '.gitignore'))
    .split('\n')
    .filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('!'));
  const dataRepoSeparated = Boolean(
    process.env.INPUT_BASE_DIR ||
    process.env.STATE_BASE_DIR
  );

  return {
    total_npm_scripts:        scripts.length,
    total_workflows:          wfFiles.length,
    total_composite_actions:  actFiles.length,
    data_repo_separated:      dataRepoSeparated,
    gitignore_protected_paths: gitignore,
  };
}

// ------------------------------------------------------------------ score calculation

function calcScore(scripts) {
  const weights = { fully_automated: 1.0, ai_assisted: 0.7, human_only: 0 };
  let num = 0, den = 0;
  for (const s of scripts) {
    const w = weights[s.automation_class] ?? 0;
    num += w;
    den += 1;
  }
  if (den === 0) return { score: 0, rationale: 'スクリプトなし' };
  const raw = (num / den) * 100;
  return {
    score:     Math.round(raw),
    rationale: `完全自動 ${scripts.filter(s=>s.automation_class==='fully_automated').length} 件 × 1.0 + AI 補助 ${scripts.filter(s=>s.automation_class==='ai_assisted').length} 件 × 0.7 + 人手 ${scripts.filter(s=>s.automation_class==='human_only').length} 件 × 0 = ${num.toFixed(1)} / ${den} = ${Math.round(raw)}%`,
  };
}

// ------------------------------------------------------------------ department data

const DEPT_META = {
  marketing:  { id: 'marketing',  display_name: '広報・マーケティング' },
  sales:      { id: 'sales',      display_name: '営業' },
  engineering:{ id: 'engineering',display_name: '技術 (engineering)' },
  planning:   { id: 'planning',   display_name: '開発企画 (planning)' },
  accounting: { id: 'accounting', display_name: '経理 (accounting)' },
};

const HUMAN_TASKS = {
  marketing:  [
    'X ポスト内容の最終確認 (自動投稿前のプレビューチェック)',
    'note 記事の公開承認 (Notion 上)',
  ],
  sales: [
    'パイプライン案件情報の入力・ステージ更新 (手動 Markdown 編集または Sheets 入力)',
    '商談対応・交渉・クロージング (人的活動)',
    '受注後の金額・条件確定 (billing セクション記入)',
  ],
  engineering: [
    'PR レビュー (AI はコメント補助のみ)',
    '生成されたテスト・ドキュメントの内容確認・修正',
    '本番デプロイの承認',
  ],
  planning: [
    '要件定義・見積の最終承認',
    '案件の優先度最終決定',
    '外部ステークホルダーとの調整',
  ],
  accounting: [
    '銀行・カード CSV のダウンロードと inputs/ への配置 (ネット銀行 API 未実装)',
    '領収書メール・レシートの inbox 管理 (物理的な整理は人が行う)',
    '入金消込の最終確認と手動確定 (自動確定条件未満の案件)',
    '税理士への説明・最終申告作業 (税務判断は税理士業務)',
    '請求書発行の最終実行 (`npm run invoice` を人が手動実行)',
    'payable ファイルの作成・支払完了後の paid: true 更新',
    '生成した税理士パッケージの送付',
  ],
};

const KNOWN_GAPS = {
  marketing:  ['SNS 返信・エンゲージメント対応は未実装', '投稿パフォーマンス分析の自動化なし'],
  sales:      ['見積書・提案書の自動生成は CLI のみ (sales 内部 npm script)、Actions 未対応', 'Sheets 連携の列が拡張途中 (billing 列は手動追加が必要)'],
  engineering:['自動デプロイ未実装', 'PR マージ後の通知・Slack 連携なし'],
  planning:   ['Notion と planning outputs の双方向同期なし', 'マイルストーン進捗の自動計測なし'],
  accounting: [
    '銀行 CSV の自動ダウンロード (外部 API または RPA)',
    '領収書 OCR 結果と経費仕訳の自動突合 (現状は別々に管理)',
    'ローカル開発と Actions 実行のデータ整合性確認手段がない',
    '確定申告・青色申告書類の自動生成',
  ],
};

// ------------------------------------------------------------------ main build

async function buildAuditReport() {
  const pkg = readJson(path.resolve(REPO_ROOT, 'package.json')) || {};
  const scripts = pkg.scripts || {};

  // スクリプト → メタデータのマッピング
  const scriptList = Object.entries(scripts).map(([name, entry]) => {
    const meta = SCRIPT_META[name] || {
      dept: 'unknown',
      purpose: '(README に未記載)',
      ai_used: false,
      ai_role: null,
      state_writes: false,
      human_judgment: '(README に未記載)',
      data_location: 'ichi-blog',
      automation_class: 'human_only',
    };
    return { name, entry, ...meta };
  });

  // 部門別整理
  const departments = Object.values(DEPT_META).map(dept => {
    const deptScripts = scriptList.filter(s => s.dept === dept.id);
    const workflows = parseWorkflows();
    const deptWorkflows = workflows.filter(w => {
      const f = w.file.toLowerCase();
      if (dept.id === 'marketing')   return f.includes('post_x') || f.includes('weekly_content');
      if (dept.id === 'sales')       return f.includes('sales');
      if (dept.id === 'engineering') return f.includes('pr-review');
      if (dept.id === 'planning')    return false;
      if (dept.id === 'accounting')  return f.includes('accounting') || f.includes('sync-from-sales') || f.includes('tax-rates');
      return false;
    });

    const scored = calcScore(deptScripts);

    return {
      id:           dept.id,
      display_name: dept.display_name,
      npm_scripts:  deptScripts.map(s => ({
        name:                    s.name,
        entry:                   s.entry,
        purpose:                 s.purpose,
        ai_used:                 s.ai_used,
        ai_role:                 s.ai_role,
        state_writes:            s.state_writes,
        human_judgment_required: s.human_judgment,
        data_location:           s.data_location,
        automation_class:        s.automation_class,
      })),
      workflows: deptWorkflows,
      automation_status: {
        fully_automated:           deptScripts.filter(s=>s.automation_class==='fully_automated').map(s=>s.purpose),
        ai_assisted_human_confirmed: deptScripts.filter(s=>s.automation_class==='ai_assisted').map(s=>s.purpose),
        human_only:                HUMAN_TASKS[dept.id] || [],
        known_gaps:                KNOWN_GAPS[dept.id] || [],
      },
      automation_score: scored,
    };
  });

  // 全 workflows
  const allWorkflows = parseWorkflows();

  // 加重平均スコア
  const totalScripts = scriptList.filter(s => s.dept !== 'unknown').length;
  const weightedSum  = departments.reduce((acc, d) => {
    return acc + d.automation_score.score * d.npm_scripts.length;
  }, 0);
  const avgScore = totalScripts > 0 ? Math.round(weightedSum / totalScripts) : 0;

  return {
    generated_at: toJSTISOString(),
    repo_state: {
      ...buildRepoState(),
      average_automation_score: avgScore,
    },
    departments,
    cross_dept_integrations: [
      {
        from: 'sales', to: 'accounting',
        flow: '受注案件 → 請求書下書き自動生成',
        script: 'sync-from-sales',
        trigger: '毎朝 09:30 JST (schedule) または手動',
        ai_involved: true,
        note: 'AI は品目名整形のみ。金額は人が入力',
      },
      {
        from: 'all', to: 'gmail',
        flow: '各部門スクリプトからのメール送信',
        script: 'lib/mailer.js (共通モジュール)',
        trigger: '各スクリプト実行時',
        ai_involved: false,
        note: 'Gmail API OAuth2。送信のみ。受信は receipt-ocr タスクで実装',
      },
      {
        from: 'accounting', to: 'ichi-data',
        flow: 'state / inputs / outputs の別リポ分離',
        script: '.github/actions/checkout-data-repo + commit-data-changes',
        trigger: 'Actions 実行時に自動 checkout / commit',
        ai_involved: false,
        note: 'DATA_REPO_TOKEN (PAT) が必要。90日で有効期限',
      },
    ],
    security: {
      sensitive_data_paths: [
        'accounting/inputs/ (顧客名・金額・請求書)',
        'accounting/state/ (採番・消込履歴)',
        'accounting/outputs/ (PDF・レポート)',
        'sales/inputs/pipeline/ (商談情報)',
      ],
      separated_repo: 'ichi-data',
      pat_required:   true,
      pat_expiry_note: 'Fine-grained PAT (DATA_REPO_TOKEN) は有効期限 90 日。再発行リマインダーは未実装 (将来課題)',
    },
    known_issues: [
      {
        severity: 'medium',
        title: 'PAT (DATA_REPO_TOKEN) の有効期限管理が手動',
        description: '90 日ごとに再発行が必要だが通知の仕組みがない。期限切れで全 Actions が失敗する',
        affected_workflows: ['accounting-payments', 'accounting-fetch-receipts', 'sync-from-sales'],
      },
      {
        severity: 'medium',
        title: 'if: always() での state コミットが失敗時に壊れた state を固定化する可能性',
        description: 'npm run <script> が失敗しても commit-data-changes が走るため、中途半端な state がコミットされる場合がある',
        affected_workflows: ['accounting-payments', 'accounting-fetch-receipts', 'sync-from-sales'],
      },
      {
        severity: 'low',
        title: 'ichi-blog 側の inputs/outputs/state に旧テストデータが残存',
        description: 'STEP A 以前のテストデータが accounting/inputs/ 等に残っており、INPUT_BASE_DIR 未設定時に混在する',
        affected_workflows: [],
      },
      {
        severity: 'low',
        title: '領収書 OCR の OAuth スコープ (gmail.readonly) が未検証',
        description: '現在の GMAIL_REFRESH_TOKEN が gmail.readonly スコープを持つかどうか、実際に OAuth 再取得するまで不明',
        affected_workflows: ['accounting-fetch-receipts'],
      },
    ],
    future_candidates: [
      {
        title: 'PAT 失効リマインダーの自動 Issue 起票',
        rationale: '90 日前に GitHub Issue を自動起票する tax-rates-annual-check と同様のパターンで実装可能',
        estimated_effort: 'small',
      },
      {
        title: '領収書 OCR 結果と経費仕訳の自動突合',
        rationale: 'receipts-index.json と categorize entries.csv の取引先・金額・日付で突合し、未紐付けを検出',
        estimated_effort: 'medium',
      },
      {
        title: '営業 Google Sheets の本格運用化',
        rationale: 'billing 列の追加と SALES_SHEET_ID の設定で sync-from-sales が Sheets ソースで動作する。Sheets 側の整備が必要',
        estimated_effort: 'medium',
      },
      {
        title: '銀行 CSV の自動ダウンロード',
        rationale: '銀行 API (GMO あおぞら等) またはマネーフォワード API で自動化可能。ただし API 利用料・利用規約の確認が必要',
        estimated_effort: 'large',
      },
      {
        title: '確定申告補助 (青色申告書類の参考生成)',
        rationale: '月次レポートの数値を元に申告参考書類を生成できるが、税務判断は税理士に委ねる設計を維持する必要がある',
        estimated_effort: 'large',
      },
    ],
  };
}

module.exports = { buildAuditReport };
