export class Store {
  constructor(sql) {
    this.sql = sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS snapshots (id TEXT PRIMARY KEY, captured_at TEXT NOT NULL, account_last4 TEXT NOT NULL, payload TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS sessions (provider TEXT PRIMARY KEY, session_id TEXT NOT NULL, created_at TEXT NOT NULL)",
    );
    sql.exec(
      "CREATE TABLE IF NOT EXISTS audit (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL, actor TEXT NOT NULL, action TEXT NOT NULL, outcome TEXT NOT NULL)",
    );
  }
  audit(actor, action, outcome) {
    this.sql.exec(
      "INSERT INTO audit(at,actor,action,outcome) VALUES(?,?,?,?)",
      new Date().toISOString(),
      actor,
      action,
      outcome,
    );
  }
  save(snapshot) {
    this.sql.exec(
      "INSERT INTO snapshots(id,captured_at,account_last4,payload) VALUES(?,?,?,?) ON CONFLICT(id) DO NOTHING",
      snapshot.sha256,
      snapshot.capturedAt,
      snapshot.account.slice(-4),
      JSON.stringify(snapshot),
    );
    return snapshot.sha256;
  }
  snapshot(id) {
    const row = [
      ...this.sql.exec("SELECT payload FROM snapshots WHERE id=?", id),
    ][0];
    if (!row) throw Error("Statement snapshot not found.");
    return JSON.parse(row.payload);
  }
  list() {
    return [
      ...this.sql.exec(
        "SELECT id,captured_at,account_last4 FROM snapshots ORDER BY captured_at DESC LIMIT 30",
      ),
    ];
  }
  session(provider) {
    return [
      ...this.sql.exec(
        "SELECT session_id FROM sessions WHERE provider=?",
        provider,
      ),
    ][0]?.session_id;
  }
  setSession(provider, id) {
    this.sql.exec(
      "INSERT INTO sessions(provider,session_id,created_at) VALUES(?,?,?) ON CONFLICT(provider) DO UPDATE SET session_id=excluded.session_id,created_at=excluded.created_at",
      provider,
      id,
      new Date().toISOString(),
    );
  }
  forgetSession(provider) {
    this.sql.exec("DELETE FROM sessions WHERE provider=?", provider);
  }
  status() {
    return {
      snapshots: this.list(),
      events: [
        ...this.sql.exec(
          "SELECT at,actor,action,outcome FROM audit ORDER BY id DESC LIMIT 20",
        ),
      ],
      mode: "review",
      tallyPosting: false,
      paymentSubmission: false,
    };
  }
}
