"use client";
import { useMemo, useState, useTransition } from "react";
import { actOnOffboardingTaskApproval } from "@/app/ops-pulse/attendance/offboarding/actions";
import type { OffboardingApprovalGate, OffboardingCase, OffboardingChecklistWorkspace, OffboardingTask } from "@/lib/ops-pulse/offboarding-checklist-data";

const dateLabel = (value: string | null) =>
  value ? new Date(`${value}T12:00:00Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" }) : "Not set";

const statusPillClass = (status: string) => {
  if (status === "approved" || status === "completed") return "status-pill good";
  if (status === "rejected" || status === "blocked") return "status-pill bad";
  if (status === "skipped" || status === "waived") return "status-pill";
  return "status-pill warn";
};

function groupByCategory(tasks: OffboardingTask[]) {
  const groups = new Map<string, OffboardingTask[]>();
  tasks.forEach((task) => {
    const list = groups.get(task.category) ?? [];
    list.push(task);
    groups.set(task.category, list);
  });
  return [...groups.entries()];
}

function ApprovalGateRow({ gate, taskId, onActed }: { gate: OffboardingApprovalGate; taskId: string; onActed: () => void }) {
  const [proofNote, setProofNote] = useState("");
  const [busy, startTransition] = useTransition();
  const [error, setError] = useState("");
  const [decision, setDecision] = useState<"approved" | "rejected" | "skipped" | null>(null);

  function submit(nextDecision: "approved" | "rejected" | "skipped") {
    setError("");
    setDecision(nextDecision);
    const formData = new FormData();
    formData.set("approvalId", gate.approvalId);
    formData.set("decision", nextDecision);
    formData.set("proofNote", proofNote.trim());
    startTransition(async () => {
      const result = await actOnOffboardingTaskApproval(formData);
      if (!result.ok) {
        setError(result.message);
        return;
      }
      onActed();
    });
  }

  return (
    <div className="ooc-gate">
      <div className="ooc-gate-head">
        <span className="ooc-gate-name">{gate.levelName}</span>
        <span className={statusPillClass(gate.status)}>{gate.status}</span>
      </div>
      {gate.status !== "pending" && (
        <small className="ooc-gate-meta">
          {gate.proofNote ? `Proof: ${gate.proofNote}` : "No proof note"}
          {gate.actedAt ? ` · ${new Date(gate.actedAt).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })}` : ""}
        </small>
      )}
      {gate.status === "pending" && !gate.unlockedByPriorLevels && (
        <small className="ooc-gate-meta">Waiting on earlier approval levels.</small>
      )}
      {gate.status === "pending" && gate.unlockedByPriorLevels && !gate.viewerCanAct && (
        <small className="ooc-gate-meta">Awaiting {gate.levelName}.</small>
      )}
      {gate.status === "pending" && gate.viewerCanAct && (
        <div className="ooc-gate-action">
          <input
            className="field"
            placeholder="Proof note (required to approve)"
            value={proofNote}
            onChange={(e) => setProofNote(e.target.value)}
            disabled={busy}
          />
          <div className="ooc-gate-buttons">
            <button type="button" className="button" disabled={busy} onClick={() => submit("approved")}>
              {busy && decision === "approved" ? "Approving…" : "Approve"}
            </button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => submit("rejected")}>
              {busy && decision === "rejected" ? "Rejecting…" : "Reject"}
            </button>
            <button type="button" className="button secondary" disabled={busy} onClick={() => submit("skipped")}>
              {busy && decision === "skipped" ? "Skipping…" : "Skip"}
            </button>
          </div>
          {error && <p className="ooc-gate-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, onActed }: { task: OffboardingTask; onActed: () => void }) {
  return (
    <div className="ooc-task">
      <div className="ooc-task-head">
        <div>
          <strong>{task.name}</strong>
          {task.isRequired && <span className="ooc-required">Required</span>}
          <span className={statusPillClass(task.status)}>{task.status}</span>
        </div>
      </div>
      {task.instructions && <p className="ooc-task-instructions">{task.instructions}</p>}
      {task.mandatoryProof && <p className="ooc-task-proof">Mandatory proof: {task.mandatoryProof}</p>}
      <div className="ooc-gates">
        {task.approvals.length === 0 && <small>No approval levels configured for this task.</small>}
        {task.approvals.map((gate) => (
          <ApprovalGateRow key={gate.approvalId} gate={gate} taskId={task.taskId} onActed={onActed} />
        ))}
      </div>
    </div>
  );
}

function CaseSection({ exitCase, onActed }: { exitCase: OffboardingCase; onActed: () => void }) {
  const categories = useMemo(() => groupByCategory(exitCase.tasks), [exitCase.tasks]);
  return (
    <section className="panel ooc-case">
      <div className="ooc-case-head">
        <div>
          <h2>{exitCase.displayName}</h2>
          <small>
            {exitCase.designationName || "No designation on file"} · Case {exitCase.caseNumber} · {exitCase.scenario}
          </small>
        </div>
        <div className="ooc-case-meta">
          <span className={statusPillClass(exitCase.status)}>{exitCase.status.replace(/_/g, " ")}</span>
          <small>Last working date: {dateLabel(exitCase.approvedLastWorkingDate || exitCase.requestedLastWorkingDate)}</small>
        </div>
      </div>
      {categories.length === 0 && <p className="ooc-empty">No checklist tasks have been generated for this case yet.</p>}
      {categories.map(([category, tasks]) => (
        <div className="ooc-category" key={category}>
          <h3>{category}</h3>
          {tasks.map((task) => (
            <TaskRow key={task.taskId} task={task} onActed={onActed} />
          ))}
        </div>
      ))}
    </section>
  );
}

export function OpsOffboardingChecklist({ initial }: { initial: OffboardingChecklistWorkspace }) {
  const [data, setData] = useState(initial);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");

  async function refresh() {
    setRefreshing(true);
    setError("");
    try {
      const response = await fetch("/api/ops-pulse/offboarding-checklist", { cache: "no-store" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || "Offboarding checklist could not be refreshed.");
      setData(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Offboarding checklist could not be refreshed.");
    } finally {
      setRefreshing(false);
    }
  }

  return (
    <div className="ooc">
      <section className="panel ooc-intro">
        <div>
          <span className="ooc-eyebrow">TEAM OPS · OFFBOARDING</span>
          <h1>Offboarding Checklist</h1>
          <p>Direct reports currently in an exit process, with their HRMS-configured clearance checklist and approval gates.</p>
        </div>
        <button className="button secondary" disabled={refreshing} onClick={refresh}>
          {refreshing ? "Refreshing…" : "Refresh"}
        </button>
      </section>
      {error && <p className="ooc-gate-error" role="alert">{error}</p>}
      {data.cases.length === 0 && (
        <section className="panel">
          <p>None of your direct reports currently have an open offboarding case.</p>
        </section>
      )}
      {data.cases.map((exitCase) => (
        <CaseSection key={exitCase.caseId} exitCase={exitCase} onActed={refresh} />
      ))}
    </div>
  );
}
