import { Database } from "bun:sqlite";
import type { ChangeOrder, ChangeOrderLine } from "../core/change-order";
import type { ClientRequest, ScopeItem } from "../core/scope";

export interface Project {
  id: string;
  title: string;
  freelancerName: string;
  clientName: string;
  clientEmail: string;
  hourlyRateCents: number;
  currency: "USD";
  agreement: string;
  scope: ScopeItem[];
  scopeConfirmed: boolean;
  amendments: string[];
  later: ChangeOrderLine[];
  createdAt: string;
}

export interface StoredRequest extends ClientRequest {
  projectId: string;
  reason: string;
  suggestedMinutes: number | null;
  injectionSuspected: boolean;
  rejectedQuotes: string[];
  downgraded: boolean;
  reviewed: boolean;
}

export interface StoredOrder {
  projectId: string;
  createdAt: string;
  invoiceStatus?: string;
  payerViewUrl?: string;
  order: ChangeOrder;
}

export interface ProjectEvent {
  at: string;
  actor: "freelancer" | "client" | "ai" | "paypal" | "system";
  type: string;
  detail: Record<string, unknown>;
}

type Row = { data: string };

export class Store {
  private readonly db: Database;

  constructor(path = ":memory:") {
    this.db = new Database(path, { create: true, strict: true });
    this.db.run("PRAGMA journal_mode = WAL");
    this.db.run("PRAGMA foreign_keys = ON");
    this.db.run(`
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        freelancer_token_hash TEXT NOT NULL,
        client_token TEXT NOT NULL UNIQUE,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS requests (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        seq INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES projects(id),
        seq INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id TEXT NOT NULL REFERENCES projects(id),
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS requests_project ON requests(project_id, seq);
      CREATE INDEX IF NOT EXISTS orders_project ON orders(project_id, seq);
      CREATE INDEX IF NOT EXISTS events_project ON events(project_id, id);
    `);
  }

  transaction<T>(work: () => T): T {
    return this.db.transaction(work)();
  }

  insertProject(project: Project, freelancerTokenHash: string, clientToken: string): void {
    this.db
      .query("INSERT INTO projects (id, freelancer_token_hash, client_token, data) VALUES (?, ?, ?, ?)")
      .run(project.id, freelancerTokenHash, clientToken, JSON.stringify(project));
  }

  saveProject(project: Project): void {
    this.db.query("UPDATE projects SET data = ? WHERE id = ?").run(JSON.stringify(project), project.id);
  }

  getProject(id: string): Project | null {
    return parse<Project>(this.db.query<Row, [string]>("SELECT data FROM projects WHERE id = ?").get(id));
  }

  getProjectByClientToken(token: string): Project | null {
    return parse<Project>(this.db.query<Row, [string]>("SELECT data FROM projects WHERE client_token = ?").get(token));
  }

  freelancerTokenHash(id: string): string | null {
    const row = this.db
      .query<{ freelancer_token_hash: string }, [string]>("SELECT freelancer_token_hash FROM projects WHERE id = ?")
      .get(id);
    return row?.freelancer_token_hash ?? null;
  }

  clientToken(id: string): string | null {
    const row = this.db.query<{ client_token: string }, [string]>("SELECT client_token FROM projects WHERE id = ?").get(id);
    return row?.client_token ?? null;
  }

  saveRequest(request: StoredRequest): void {
    this.upsert("requests", request.id, request.projectId, request);
  }

  getRequest(projectId: string, id: string): StoredRequest | null {
    return parse<StoredRequest>(
      this.db.query<Row, [string, string]>("SELECT data FROM requests WHERE id = ? AND project_id = ?").get(id, projectId),
    );
  }

  listRequests(projectId: string): StoredRequest[] {
    return this.list<StoredRequest>("requests", projectId);
  }

  saveOrder(stored: StoredOrder): void {
    this.upsert("orders", stored.order.id, stored.projectId, stored);
  }

  getOrder(projectId: string, id: string): StoredOrder | null {
    return parse<StoredOrder>(
      this.db.query<Row, [string, string]>("SELECT data FROM orders WHERE id = ? AND project_id = ?").get(id, projectId),
    );
  }

  listOrders(projectId: string): StoredOrder[] {
    return this.list<StoredOrder>("orders", projectId);
  }

  deleteOrder(projectId: string, id: string): void {
    this.db.query("DELETE FROM orders WHERE id = ? AND project_id = ?").run(id, projectId);
  }

  addEvent(projectId: string, event: ProjectEvent): void {
    this.db.query("INSERT INTO events (project_id, data) VALUES (?, ?)").run(projectId, JSON.stringify(event));
  }

  listEvents(projectId: string): ProjectEvent[] {
    return this.db
      .query<Row, [string]>("SELECT data FROM events WHERE project_id = ? ORDER BY id")
      .all(projectId)
      .map((row) => JSON.parse(row.data) as ProjectEvent);
  }

  close(): void {
    this.db.close();
  }

  private upsert(table: "requests" | "orders", id: string, projectId: string, value: unknown): void {
    this.db
      .query(
        `INSERT INTO ${table} (id, project_id, seq, data)
         VALUES (?1, ?2, (SELECT COALESCE(MAX(seq), 0) + 1 FROM ${table} WHERE project_id = ?2), ?3)
         ON CONFLICT(id) DO UPDATE SET data = excluded.data`,
      )
      .run(id, projectId, JSON.stringify(value));
  }

  private list<T>(table: "requests" | "orders", projectId: string): T[] {
    return this.db
      .query<Row, [string]>(`SELECT data FROM ${table} WHERE project_id = ? ORDER BY seq`)
      .all(projectId)
      .map((row) => JSON.parse(row.data) as T);
  }
}

function parse<T>(row: Row | null): T | null {
  return row ? (JSON.parse(row.data) as T) : null;
}
