-- Per-company SQLite schema (Cloudflare Durable Object `CompanyDO` SQLite and local self-hosted `<company>.sqlite`).
-- Every replicable table carries `_deleted`, `_hlc`, and `_site` for bidirectional HLC delta sync.

CREATE TABLE IF NOT EXISTS schema_migration (
  version TEXT PRIMARY KEY,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS _sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS _changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  table_name TEXT NOT NULL,
  pk TEXT NOT NULL,
  op TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
  columns TEXT NOT NULL DEFAULT '{}',
  hlc TEXT NOT NULL,
  site TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS _changes_hlc_idx ON _changes (hlc, seq);

CREATE TABLE IF NOT EXISTS _purge_token (
  company_id TEXT PRIMARY KEY,
  retention_until TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS company_profile (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  siren TEXT NOT NULL,
  siret TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  vat_number TEXT,
  vat_exempt INTEGER NOT NULL DEFAULT 0,
  suspended_at TEXT,
  retention_until TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud'
);

CREATE TABLE IF NOT EXISTS customer (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  tax_id TEXT,
  address TEXT NOT NULL,
  vat_number TEXT,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud',
  UNIQUE (company_id, id)
);

CREATE TABLE IF NOT EXISTS supplier (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  address TEXT NOT NULL DEFAULT '',
  tax_id TEXT NOT NULL DEFAULT '',
  vat_number TEXT,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud'
);

CREATE TABLE IF NOT EXISTS product (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  description TEXT NOT NULL,
  unit_price_excl_vat_cents INTEGER NOT NULL CHECK (unit_price_excl_vat_cents >= 0),
  vat INTEGER NOT NULL CHECK (vat IN (0, 21, 55, 100, 200)),
  unit TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud',
  UNIQUE (company_id, id)
);

CREATE TABLE IF NOT EXISTS counter (
  company_id TEXT NOT NULL,
  series TEXT NOT NULL,
  year INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  PRIMARY KEY (company_id, series, year)
);

CREATE TABLE IF NOT EXISTS document (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('quote', 'invoice', 'deposit', 'credit_note')),
  status TEXT NOT NULL DEFAULT 'draft',
  number TEXT,
  series TEXT,
  year INTEGER,
  seq INTEGER,
  customer_id TEXT,
  data TEXT NOT NULL,
  excl_vat_cents INTEGER NOT NULL,
  vat_cents INTEGER NOT NULL,
  incl_vat_cents INTEGER NOT NULL,
  portal_token TEXT UNIQUE,
  issued_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud',
  UNIQUE (company_id, id),
  UNIQUE (company_id, number),
  UNIQUE (company_id, series, year, seq),
  CHECK ((status = 'draft') = (number IS NULL))
);
CREATE INDEX IF NOT EXISTS document_company_type_idx ON document (company_id, type, created_at DESC);
CREATE INDEX IF NOT EXISTS document_customer_idx ON document (company_id, customer_id);
CREATE INDEX IF NOT EXISTS document_origin_idx ON document (company_id, json_extract(data, '$.origin')) WHERE type = 'credit_note';

CREATE TRIGGER IF NOT EXISTS document_immutable_update BEFORE UPDATE ON document
WHEN OLD.status <> 'draft' AND (
     NEW.data IS NOT OLD.data OR NEW.number IS NOT OLD.number
  OR NEW.type IS NOT OLD.type OR NEW.incl_vat_cents IS NOT OLD.incl_vat_cents
  OR NEW.company_id IS NOT OLD.company_id OR NEW.issued_at IS NOT OLD.issued_at
  OR NEW.customer_id IS NOT OLD.customer_id OR NEW._deleted <> 0
)
BEGIN
  SELECT RAISE(ABORT, 'issued document cannot be modified; issue a credit note instead');
END;

CREATE TRIGGER IF NOT EXISTS document_immutable_delete BEFORE DELETE ON document
WHEN OLD.status <> 'draft'
 AND NOT EXISTS (
   SELECT 1 FROM _purge_token p
   WHERE p.company_id = OLD.company_id AND p.retention_until < date('now')
 )
BEGIN
  SELECT RAISE(ABORT, 'issued document cannot be deleted before retention expiry');
END;

CREATE TABLE IF NOT EXISTS usage_counter (
  company_id TEXT NOT NULL,
  metric TEXT NOT NULL,
  period TEXT NOT NULL DEFAULT '',
  quantity INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (company_id, metric, period)
);

CREATE TRIGGER IF NOT EXISTS usage_on_issue AFTER UPDATE OF status ON document
WHEN OLD.status = 'draft' AND NEW.status <> 'draft' AND NEW.type IN ('invoice', 'deposit', 'credit_note')
BEGIN
  INSERT INTO usage_counter (company_id, metric, period, quantity)
  VALUES (NEW.company_id, 'invoices', strftime('%Y-%m', coalesce(NEW.issued_at, 'now')), 1)
  ON CONFLICT (company_id, metric, period) DO UPDATE SET quantity = quantity + 1;
END;

CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company_id TEXT NOT NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  actor TEXT,
  action TEXT NOT NULL,
  ref TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_company_idx ON audit_log (company_id, id);

CREATE TRIGGER IF NOT EXISTS audit_chain_check BEFORE INSERT ON audit_log
BEGIN
  SELECT RAISE(ABORT, 'audit: invalid prev_hash')
  WHERE NEW.prev_hash <> coalesce(
    (SELECT a.hash FROM audit_log a WHERE a.company_id = NEW.company_id ORDER BY a.id DESC LIMIT 1),
    '0000000000000000000000000000000000000000000000000000000000000000'
  );
END;

CREATE TRIGGER IF NOT EXISTS audit_immutable_update BEFORE UPDATE ON audit_log BEGIN
  SELECT RAISE(ABORT, 'audit: append-only');
END;
CREATE TRIGGER IF NOT EXISTS audit_immutable_delete BEFORE DELETE ON audit_log
WHEN NOT EXISTS (
  SELECT 1 FROM _purge_token p WHERE p.company_id = OLD.company_id AND p.retention_until < date('now')
)
BEGIN
  SELECT RAISE(ABORT, 'audit: append-only');
END;

CREATE TABLE IF NOT EXISTS artifact (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('facturx', 'pdf')),
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  content BLOB,
  blob_key TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (company_id, id),
  UNIQUE (document_id, kind)
);

CREATE TRIGGER IF NOT EXISTS artifact_immutable_update BEFORE UPDATE ON artifact BEGIN
  SELECT RAISE(ABORT, 'artifact: append-only');
END;
CREATE TRIGGER IF NOT EXISTS artifact_immutable_delete BEFORE DELETE ON artifact
WHEN NOT EXISTS (
  SELECT 1 FROM _purge_token p WHERE p.company_id = OLD.company_id AND p.retention_until < date('now')
)
BEGIN
  SELECT RAISE(ABORT, 'artifact: append-only');
END;

CREATE TABLE IF NOT EXISTS payment (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  date TEXT NOT NULL,
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
  method TEXT NOT NULL CHECK (method IN ('transfer', 'card', 'check', 'cash', 'direct_debit', 'other')),
  reference TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX IF NOT EXISTS payment_doc_idx ON payment (company_id, document_id);

CREATE TRIGGER IF NOT EXISTS payment_immutable_update BEFORE UPDATE ON payment BEGIN
  SELECT RAISE(ABORT, 'payment: append-only');
END;
CREATE TRIGGER IF NOT EXISTS payment_immutable_delete BEFORE DELETE ON payment
WHEN NOT EXISTS (
  SELECT 1 FROM _purge_token p WHERE p.company_id = OLD.company_id AND p.retention_until < date('now')
)
BEGIN
  SELECT RAISE(ABORT, 'payment: append-only');
END;

CREATE TABLE IF NOT EXISTS reminder (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  level INTEGER NOT NULL CHECK (level BETWEEN 1 AND 3),
  channel TEXT NOT NULL CHECK (channel IN ('email', 'postal', 'phone')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (document_id, level)
);

CREATE TRIGGER IF NOT EXISTS reminder_immutable_update BEFORE UPDATE ON reminder BEGIN
  SELECT RAISE(ABORT, 'reminder: append-only');
END;
CREATE TRIGGER IF NOT EXISTS reminder_immutable_delete BEFORE DELETE ON reminder
WHEN NOT EXISTS (
  SELECT 1 FROM _purge_token p WHERE p.company_id = OLD.company_id AND p.retention_until < date('now')
)
BEGIN
  SELECT RAISE(ABORT, 'reminder: append-only');
END;

CREATE TABLE IF NOT EXISTS subscription_schedule (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  title TEXT NOT NULL,
  lines_json TEXT NOT NULL,
  interval TEXT NOT NULL CHECK (interval IN ('monthly', 'quarterly', 'annual')),
  next_run_at TEXT NOT NULL,
  auto_issue INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud'
);

CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  code TEXT NOT NULL DEFAULT '',
  customer_id TEXT,
  address TEXT NOT NULL DEFAULT '',
  budget_excl_vat_cents INTEGER NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'active', 'completed', 'paused')),
  start_date TEXT,
  end_date TEXT,
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud'
);

CREATE TABLE IF NOT EXISTS project_document (
  company_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud',
  PRIMARY KEY (company_id, project_id, document_id)
);

CREATE TABLE IF NOT EXISTS supplier_document (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('delivery_note', 'order_confirmation')),
  reference TEXT NOT NULL,
  supplier_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  received_invoice_id TEXT,
  date TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'validated', 'cancelled')),
  lines_json TEXT NOT NULL DEFAULT '[]',
  notes TEXT NOT NULL DEFAULT '',
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud'
);

CREATE TABLE IF NOT EXISTS received_invoice (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  number TEXT NOT NULL DEFAULT '',
  supplier_name TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review', 'validated', 'rejected')),
  total_excl_vat_cents INTEGER NOT NULL DEFAULT 0,
  total_vat_cents INTEGER NOT NULL DEFAULT 0,
  total_incl_vat_cents INTEGER NOT NULL DEFAULT 0,
  currency TEXT NOT NULL DEFAULT 'EUR',
  data_json TEXT NOT NULL DEFAULT '{}',
  blob_key TEXT,
  sha256 TEXT,
  supplier_id TEXT,
  project_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud'
);

CREATE TABLE IF NOT EXISTS received_quote (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  number TEXT NOT NULL DEFAULT '',
  supplier_name TEXT NOT NULL DEFAULT '',
  date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'review' CHECK (status IN ('review', 'validated', 'rejected')),
  total_incl_vat_cents INTEGER NOT NULL DEFAULT 0,
  raw_text TEXT NOT NULL DEFAULT '',
  data_json TEXT NOT NULL DEFAULT '{}',
  blob_key TEXT,
  sha256 TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud'
);

CREATE TABLE IF NOT EXISTS stored_file (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  blob_key TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (company_id, sha256)
);

CREATE TABLE IF NOT EXISTS file_source (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  root TEXT NOT NULL,
  sub_path TEXT NOT NULL DEFAULT '',
  segment TEXT NOT NULL DEFAULT 'suppliers',
  mode TEXT NOT NULL DEFAULT 'index' CHECK (mode IN ('index', 'invoice', 'quote')),
  active INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT,
  error TEXT,
  cursor TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud',
  UNIQUE (company_id, root, sub_path)
);

CREATE TABLE IF NOT EXISTS indexed_file (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  file_id TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  segment TEXT NOT NULL,
  text_content TEXT NOT NULL DEFAULT '',
  sha256 TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  received_quote_id TEXT,
  received_invoice_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud',
  UNIQUE (company_id, source_id, path, sha256)
);

CREATE TABLE IF NOT EXISTS studio_document (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  format TEXT NOT NULL CHECK (format IN ('docx', 'xlsx', 'pptx', 'pdf')),
  segment TEXT NOT NULL DEFAULT 'customers',
  revision INTEGER NOT NULL DEFAULT 1,
  archived INTEGER NOT NULL DEFAULT 0,
  file_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud'
);

CREATE TABLE IF NOT EXISTS studio_revision (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  file_id TEXT NOT NULL,
  actor TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (document_id, revision)
);

CREATE TABLE IF NOT EXISTS employee (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  last_name TEXT NOT NULL CHECK (trim(last_name) <> ''),
  first_name TEXT NOT NULL CHECK (trim(first_name) <> ''),
  email TEXT,
  role TEXT NOT NULL,
  contract TEXT NOT NULL CHECK (contract IN ('permanent', 'fixed_term', 'apprenticeship', 'professionalization', 'internship', 'temporary')),
  start_date TEXT NOT NULL,
  end_date TEXT,
  working_time_percent INTEGER NOT NULL DEFAULT 100 CHECK (working_time_percent BETWEEN 1 AND 100),
  gross_monthly_salary_cents INTEGER NOT NULL CHECK (gross_monthly_salary_cents >= 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud'
);

CREATE TABLE IF NOT EXISTS absence (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  employee_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('paid_leave', 'rtt', 'sick_leave', 'unpaid_leave', 'family_event', 'other')),
  start_date TEXT NOT NULL,
  end_date TEXT NOT NULL,
  days INTEGER NOT NULL CHECK (days > 0),
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'approved', 'rejected', 'cancelled')),
  notes TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud'
);

CREATE TABLE IF NOT EXISTS mailbox_account (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL CHECK (provider IN ('google', 'microsoft', 'imap')),
  address TEXT NOT NULL,
  secret_enc BLOB,
  cursor_json TEXT NOT NULL DEFAULT '{}',
  active INTEGER NOT NULL DEFAULT 1,
  synced_at TEXT,
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS mailbox_message (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  message_id TEXT,
  sender TEXT NOT NULL,
  recipients_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL DEFAULT '',
  sent_at TEXT NOT NULL,
  read_flag INTEGER NOT NULL DEFAULT 0,
  folder TEXT NOT NULL DEFAULT 'inbox' CHECK (folder IN ('inbox', 'sent')),
  present INTEGER NOT NULL DEFAULT 1,
  UNIQUE (account_id, remote_id)
);

CREATE TABLE IF NOT EXISTS mailbox_attachment (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  blob_key TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size INTEGER NOT NULL,
  UNIQUE (message_id, idx)
);

CREATE TABLE IF NOT EXISTS automation (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 1,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud'
);

CREATE TABLE IF NOT EXISTS automation_version (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  definition_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (automation_id, version)
);

CREATE TABLE IF NOT EXISTS automation_run (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  automation_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'success', 'error')),
  trigger_type TEXT NOT NULL,
  steps_json TEXT NOT NULL DEFAULT '[]',
  output_json TEXT NOT NULL DEFAULT '[]',
  error TEXT,
  started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  finished_at TEXT
);

CREATE TABLE IF NOT EXISTS knowledge_doc (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  source TEXT NOT NULL,
  title TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud'
);

CREATE TABLE IF NOT EXISTS knowledge_chunk (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  doc_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  heading TEXT,
  content TEXT NOT NULL,
  embedding BLOB,
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud',
  UNIQUE (doc_id, chunk_index)
);

CREATE TABLE IF NOT EXISTS einvoice_submission (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  external_id TEXT,
  status TEXT NOT NULL,
  raw_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS webhook_endpoint (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events_json TEXT NOT NULL DEFAULT '["*"]',
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS outbox (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE IF NOT EXISTS template_config (
  company_id TEXT PRIMARY KEY,
  color TEXT,
  logo_mime TEXT,
  logo_data_base64 TEXT,
  footer TEXT,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  _deleted INTEGER NOT NULL DEFAULT 0,
  _hlc TEXT NOT NULL DEFAULT '',
  _site TEXT NOT NULL DEFAULT 'cloud'
);
