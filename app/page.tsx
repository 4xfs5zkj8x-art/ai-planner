"use client";

import React, { useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  CalendarDays,
  CheckCircle2,
  ClipboardList,
  Clock,
  MessageCircle,
  Plus,
  RefreshCcw,
  Settings2,
  Trash2,
} from "lucide-react";

/**
 * AI Planner (2 screens) + AI Chat (preview -> confirm -> apply)
 * - Stores state in localStorage
 * - AI endpoints:
 *   POST /api/plan  -> returns preview + action (NOT applied)
 *   POST /api/apply -> applies a previously previewed action (requires confirm phrase)
 */

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
type Day = (typeof DAYS)[number];
type TaskPriority = "low" | "medium" | "high";

type Preferences = {
  workBlockMins: number;
  maxBlocksPerDay: number;
  startHour: number;
  endHour: number;
};

type BusyBlock = {
  id: string;
  day: Day;
  startMin: number;
  endMin: number;
  label: string;
};

type PlannedBlock = {
  id: string;
  day: Day;
  startMin: number;
  endMin: number;
  type: "plan";
  taskId?: string;
  label?: string;
};

type Task = {
  id: string;
  title: string;
  dueDate: string; // YYYY-MM-DD
  priority: TaskPriority;
  estimateMins: number;
  done: boolean;
  createdAt: number;
};

type AppState = {
  preferences: Preferences;
  busyBlocks: BusyBlock[];
  plannedBlocks: PlannedBlock[];
  tasks: Task[];
};

type AIAction = {
  preferences?: Partial<Preferences>;
  addBusyBlocks?: Array<{ day: Day; startMin: number; endMin: number; label?: string }>;
  addTasks?: Array<{ title: string; dueDate: string; priority?: TaskPriority; estimateMins?: number }>;
  replan?: boolean;
};

type AIPlanResponse = {
  preview: string;        // human summary
  action: AIAction;       // machine action
  confirmationToken: string; // token to bind preview->apply
};

const LS_KEY = "ai_planner_state_v1";

const DEFAULT_STATE: AppState = {
  preferences: { workBlockMins: 50, maxBlocksPerDay: 3, startHour: 6, endHour: 22 },
  busyBlocks: [],
  plannedBlocks: [],
  tasks: [],
};

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(16).slice(2)}_${Date.now().toString(16)}`;
}

function clamp(n: number, a: number, b: number) {
  return Math.max(a, Math.min(b, n));
}

function minutesToLabel(mins: number) {
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const hh = ((h % 24) + 24) % 24;
  const ampm = hh >= 12 ? "PM" : "AM";
  const h12 = hh % 12 === 0 ? 12 : hh % 12;
  return `${h12}:${m.toString().padStart(2, "0")} ${ampm}`;
}

function Pill({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs ${className}`}>{children}</span>;
}

function Button({
  children, onClick, variant = "solid", className = "", disabled,
}: {
  children: React.ReactNode;
  onClick?: () => void;
  variant?: "solid" | "outline" | "ghost";
  className?: string;
  disabled?: boolean;
}) {
  const base =
    "inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-2 text-sm font-medium transition active:scale-[0.99] disabled:opacity-50 disabled:cursor-not-allowed";
  const styles =
    variant === "solid" ? "bg-black text-white hover:bg-black/90"
    : variant === "ghost" ? "bg-transparent hover:bg-black/5"
    : "bg-white border hover:bg-black/5";
  return (
    <button disabled={disabled} onClick={onClick} className={`${base} ${styles} ${className}`}>
      {children}
    </button>
  );
}

function Input({
  value, onChange, placeholder = "", type = "text", className = "",
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
}) {
  return (
    <input
      value={value}
      type={type}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={`w-full rounded-2xl border bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10 ${className}`}
    />
  );
}

function Modal({
  open, title, children, onClose,
}: {
  open: boolean;
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <AnimatePresence>
      {open ? (
        <motion.div
          className="fixed inset-0 z-50 flex items-end justify-center p-4 sm:items-center"
          initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/30" onClick={onClose} />
          <motion.div
            className="relative w-full max-w-lg rounded-3xl bg-white p-5 shadow-xl"
            initial={{ y: 24, opacity: 0, scale: 0.98 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: 24, opacity: 0, scale: 0.98 }}
          >
            <div className="mb-3 flex items-center justify-between">
              <div className="text-base font-semibold">{title}</div>
              <button className="rounded-full p-2 hover:bg-black/5" onClick={onClose} aria-label="Close">✕</button>
            </div>
            {children}
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>
  );
}

// ------- Auto-plan (simple rule engine) -------
function buildFreeGrid(preferences: Preferences, busyBlocks: BusyBlock[]) {
  const start = preferences.startHour * 60;
  const end = preferences.endHour * 60;

  const free: Record<Day, Array<{ start: number; end: number }>> = Object.fromEntries(
    DAYS.map((d) => [d, [{ start, end }]])
  ) as any;

  for (const b of busyBlocks) {
    const slots = free[b.day] || [];
    const next: Array<{ start: number; end: number }> = [];
    for (const s of slots) {
      if (b.endMin <= s.start || b.startMin >= s.end) { next.push(s); continue; }
      if (b.startMin > s.start) next.push({ start: s.start, end: b.startMin });
      if (b.endMin < s.end) next.push({ start: b.endMin, end: s.end });
    }
    free[b.day] = next.filter((x) => x.end - x.start >= 15).sort((a,b2)=>a.start-b2.start);
  }

  return free;
}

function scoreTask(t: Task) {
  const due = new Date(`${t.dueDate}T00:00:00`);
  const today = new Date();
  const daysLeft = Math.max(0, Math.floor((due.getTime() - today.getTime()) / (1000*60*60*24)));
  const urgency = 1 / Math.max(1, daysLeft + 1);
  const p = ({ low: 0.7, medium: 1.0, high: 1.35 } as const)[t.priority] ?? 1.0;
  const sizePenalty = Math.pow(Math.max(15, t.estimateMins)/60, 0.15);
  return (urgency * p) / sizePenalty;
}

function autoPlan(preferences: Preferences, busyBlocks: BusyBlock[], tasks: Task[]) {
  const free = buildFreeGrid(preferences, busyBlocks);

  const units: Array<{ taskId: string; label: string; mins: number; score: number }> = [];
  for (const t of tasks) {
    if (t.done) continue;
    const remaining = Math.max(0, t.estimateMins);
    if (remaining <= 0) continue;

    const block = preferences.workBlockMins;
    const parts = Math.max(1, Math.ceil(remaining / block));
    for (let i=0;i<parts;i++){
      const mins = i === parts-1 ? remaining - block*(parts-1) : block;
      units.push({
        taskId: t.id,
        label: parts===1 ? t.title : `${t.title} (Part ${i+1}/${parts})`,
        mins: Math.max(15, Math.round(mins)),
        score: scoreTask(t),
      });
    }
  }

  units.sort((a,b)=>b.score-a.score);

  const planned: PlannedBlock[] = [];
  const dailyCount: Record<Day, number> = Object.fromEntries(DAYS.map(d=>[d,0])) as any;

  for (const u of units) {
    for (const day of DAYS) {
      if (dailyCount[day] >= preferences.maxBlocksPerDay) continue;
      const segs = free[day];
      for (let si=0; si<segs.length; si++){
        const s = segs[si];
        if (s.end - s.start >= u.mins) {
          const startMin = s.start;
          const endMin = startMin + u.mins;

          planned.push({ id: uid("plan"), day, startMin, endMin, type:"plan", taskId: u.taskId, label: u.label });
          dailyCount[day]++;

          const nextSegs: Array<{start:number;end:number}> = [];
          if (endMin < s.end) nextSegs.push({ start: endMin, end: s.end });
          segs.splice(si,1,...nextSegs);
          free[day] = segs.filter(x=>x.end-x.start>=15);
          si = segs.length; // break inner
          break;
        }
      }
      if (planned.some(p=>p.taskId===u.taskId && p.label===u.label)) break;
    }
  }

  planned.sort((a,b)=>DAYS.indexOf(a.day)-DAYS.indexOf(b.day) || a.startMin-b.startMin);
  return planned;
}

// ------- App -------
export default function Page() {
  const [tab, setTab] = useState<"schedule" | "todo">("schedule");
  const [state, setState] = useState<AppState>(DEFAULT_STATE);
  const [toast, setToast] = useState<{ type: "ok" | "error"; msg: string } | null>(null);

  const [chatOpen, setChatOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role:"user"|"assistant"; content:string }>>([
    { role:"assistant", content:"Tell me your tasks/events in plain text. I’ll propose a plan, then you confirm to apply it." }
  ]);
  const [chatInput, setChatInput] = useState("");
  const [chatSending, setChatSending] = useState(false);

  const [pendingPlan, setPendingPlan] = useState<AIPlanResponse | null>(null);

  const [addBusyOpen, setAddBusyOpen] = useState(false);
  const [addTaskOpen, setAddTaskOpen] = useState(false);

  // Busy form
  const [busyDay, setBusyDay] = useState<Day>("Mon");
  const [busyStart, setBusyStart] = useState("09:00");
  const [busyEnd, setBusyEnd] = useState("10:00");
  const [busyLabel, setBusyLabel] = useState("Class / Work");

  // Task form
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDue, setTaskDue] = useState(new Date().toISOString().slice(0,10));
  const [taskPriority, setTaskPriority] = useState<TaskPriority>("medium");
  const [taskEstimate, setTaskEstimate] = useState("120");

  useEffect(() => {
    const loaded = (() => {
      try {
        const raw = localStorage.getItem(LS_KEY);
        return raw ? (JSON.parse(raw) as AppState) : null;
      } catch { return null; }
    })();
    if (loaded) setState(loaded);
  }, []);

  useEffect(() => {
    try { localStorage.setItem(LS_KEY, JSON.stringify(state)); } catch {}
  }, [state]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 2000);
    return () => clearTimeout(t);
  }, [toast]);

  const tasksById = useMemo(() => new Map(state.tasks.map(t=>[t.id,t])), [state.tasks]);

  const allBlocks = useMemo(() => {
    const busy = state.busyBlocks.map(b=>({ ...b, type:"busy" as const }));
    const plan = state.plannedBlocks.map(b=>({ ...b, type:"plan" as const }));
    return [...busy, ...plan];
  }, [state.busyBlocks, state.plannedBlocks]);

  function replanNow(s: AppState) {
    const plannedBlocks = autoPlan(s.preferences, s.busyBlocks, s.tasks);
    return { ...s, plannedBlocks };
  }

  function applyAction(action: AIAction) {
    setState(prev => {
      let next: AppState = { ...prev };

      if (action.preferences) next.preferences = { ...next.preferences, ...action.preferences };

      if (action.addBusyBlocks?.length) {
        next.busyBlocks = [
          ...next.busyBlocks,
          ...action.addBusyBlocks.map(b=>({
            id: uid("busy"),
            day: b.day,
            startMin: b.startMin,
            endMin: b.endMin,
            label: b.label ?? "Busy",
          }))
        ];
      }

      if (action.addTasks?.length) {
        next.tasks = [
          ...action.addTasks.map(t=>({
            id: uid("task"),
            title: t.title,
            dueDate: t.dueDate,
            priority: t.priority ?? "medium",
            estimateMins: clamp(Number(t.estimateMins ?? 60), 15, 1440),
            done: false,
            createdAt: Date.now(),
            spentMins: 0, // unused but kept conceptually
          })) as any,
          ...next.tasks
        ] as any;
      }

      if (action.replan) next = replanNow(next);
      return next;
    });
  }

  function addBusyBlock() {
    const [sh, sm] = busyStart.split(":").map(Number);
    const [eh, em] = busyEnd.split(":").map(Number);
    const startMin = clamp(sh*60+sm, 0, 1440);
    const endMin = clamp(eh*60+em, 0, 1440);
    if (endMin <= startMin + 10) { setToast({type:"error", msg:"End must be after start."}); return; }
    setState(s => ({ ...s, busyBlocks: [...s.busyBlocks, { id: uid("busy"), day: busyDay, startMin, endMin, label: busyLabel || "Busy" }] }));
    setAddBusyOpen(false);
    setToast({type:"ok", msg:"Busy time added."});
  }

  function addTask() {
    if (!taskTitle.trim()) { setToast({type:"error", msg:"Task title required."}); return; }
    const est = clamp(parseInt(taskEstimate || "60", 10) || 60, 15, 1440);
    setState(s => ({
      ...s,
      tasks: [{
        id: uid("task"),
        title: taskTitle.trim(),
        dueDate: taskDue,
        priority: taskPriority,
        estimateMins: est,
        done: false,
        createdAt: Date.now(),
      }, ...s.tasks]
    }));
    setTaskTitle("");
    setTaskEstimate("120");
    setAddTaskOpen(false);
    setToast({type:"ok", msg:"Task added."});
  }

  function toggleDone(taskId: string) {
    setState(s => ({ ...s, tasks: s.tasks.map(t=>t.id===taskId ? { ...t, done: !t.done } : t) }));
  }

  function deleteTask(taskId: string) {
    setState(s => ({
      ...s,
      tasks: s.tasks.filter(t=>t.id!==taskId),
      plannedBlocks: s.plannedBlocks.filter(b=>b.taskId!==taskId),
    }));
  }

  async function sendChat() {
    const text = chatInput.trim();
    if (!text || chatSending) return;

    setChatInput("");
    setChatMessages(m => [...m, { role:"user", content: text }]);
    setChatSending(true);

    try {
      // If user confirms, apply pending plan
      const confirmWords = ["confirmo", "sí", "si", "confirm", "ok", "dale", "aplica"];
      const isConfirm = confirmWords.some(w => text.toLowerCase() === w || text.toLowerCase().includes(w));

      if (pendingPlan && isConfirm) {
        const res = await fetch("/api/apply", {
          method:"POST",
          headers:{ "Content-Type":"application/json" },
          body: JSON.stringify({
            confirmationToken: pendingPlan.confirmationToken,
            action: pendingPlan.action,
            userConfirmationText: text
          }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data?.error || "Apply failed");

        applyAction(pendingPlan.action);
        setChatMessages(m => [...m, { role:"assistant", content:"✅ Applied. Your schedule & to-do were updated." }]);
        setPendingPlan(null);
        setToast({ type:"ok", msg:"Applied & replanned." });
        return;
      }

      // Otherwise: ask the AI to create a preview plan
      const res = await fetch("/api/plan", {
        method:"POST",
        headers:{ "Content-Type":"application/json" },
        body: JSON.stringify({
          message: text,
          state: {
            preferences: state.preferences,
            busyBlocks: state.busyBlocks,
            tasks: state.tasks
          }
        }),
      });

      const data: AIPlanResponse = await res.json();
      if (!res.ok) throw new Error((data as any)?.error || "Plan failed");

      setPendingPlan(data);
      setChatMessages(m => [
        ...m,
        { role:"assistant", content: data.preview + "\n\nType “confirmo” to apply, or write changes." }
      ]);
    } catch (e: any) {
      setChatMessages(m => [...m, { role:"assistant", content: `❌ Error: ${e?.message ?? "unknown"}` }]);
    } finally {
      setChatSending(false);
    }
  }

  function manualAutoPlan() {
    setState(s => replanNow(s));
    setToast({type:"ok", msg:"Plan updated."});
  }

  function clearPlan() {
    setState(s => ({ ...s, plannedBlocks: [] }));
    setToast({type:"ok", msg:"Cleared planned blocks."});
  }

  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-900">
      <div className="mx-auto max-w-6xl px-4 py-6">
        <header className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="inline-flex items-center gap-2 rounded-full border bg-white px-3 py-1 text-xs">
              <span className="h-2 w-2 rounded-full bg-black" />
              <span className="font-medium">AI Planner</span>
              <span className="text-neutral-500">• web MVP</span>
            </div>
            <h1 className="mt-3 text-2xl font-semibold tracking-tight sm:text-3xl">
              Two screens. Zero mental load.
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-neutral-600">
              Add busy time and tasks—or just tell the AI in chat. It will propose a plan, then you confirm to apply.
            </p>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setChatOpen(true)}>
              <MessageCircle className="h-4 w-4" /> AI Chat
            </Button>
            <Button variant="outline" onClick={clearPlan}>
              <RefreshCcw className="h-4 w-4" /> Clear Plan
            </Button>
            <Button onClick={manualAutoPlan}>
              <RefreshCcw className="h-4 w-4" /> Auto-Plan
            </Button>
          </div>
        </header>

        <div className="mb-4 flex w-full gap-2 rounded-3xl border bg-white p-2">
          <button
            onClick={() => setTab("schedule")}
            className={`flex w-full items-center justify-center gap-2 rounded-2xl px-3 py-2 text-sm font-medium transition ${
              tab === "schedule" ? "bg-black text-white" : "hover:bg-black/5"
            }`}
          >
            <CalendarDays className="h-4 w-4" /> Weekly Schedule
          </button>
          <button
            onClick={() => setTab("todo")}
            className={`flex w-full items-center justify-center gap-2 rounded-2xl px-3 py-2 text-sm font-medium transition ${
              tab === "todo" ? "bg-black text-white" : "hover:bg-black/5"
            }`}
          >
            <ClipboardList className="h-4 w-4" /> To-Do List
          </button>
        </div>

        <AnimatePresence mode="wait">
          {tab === "schedule" ? (
            <motion.div key="schedule" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} transition={{ duration: 0.18 }}>
              <ScheduleView
                preferences={state.preferences}
                blocks={allBlocks}
                tasksById={tasksById}
                onAddBusy={() => setAddBusyOpen(true)}
                onRemoveBlock={(id) => setState(s => ({ ...s, busyBlocks: s.busyBlocks.filter(b=>b.id!==id), plannedBlocks: s.plannedBlocks.filter(b=>b.id!==id) }))}
              />
            </motion.div>
          ) : (
            <motion.div key="todo" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 10 }} transition={{ duration: 0.18 }}>
              <TodoView
                tasks={state.tasks}
                plannedBlocks={state.plannedBlocks}
                onAddTask={() => setAddTaskOpen(true)}
                onToggleDone={toggleDone}
                onDeleteTask={deleteTask}
              />
            </motion.div>
          )}
        </AnimatePresence>
      </div>

      {/* Add Busy Modal */}
      <Modal open={addBusyOpen} title="Add busy time" onClose={() => setAddBusyOpen(false)}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div>
            <div className="mb-1 text-xs font-medium text-neutral-600">Day</div>
            <select value={busyDay} onChange={(e)=>setBusyDay(e.target.value as Day)} className="w-full rounded-2xl border bg-white px-3 py-2 text-sm">
              {DAYS.map(d=><option key={d} value={d}>{d}</option>)}
            </select>
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-neutral-600">Label</div>
            <Input value={busyLabel} onChange={setBusyLabel} placeholder="Class / Work / Gym" />
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-neutral-600">Start</div>
            <Input value={busyStart} onChange={setBusyStart} type="time" />
          </div>
          <div>
            <div className="mb-1 text-xs font-medium text-neutral-600">End</div>
            <Input value={busyEnd} onChange={setBusyEnd} type="time" />
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setAddBusyOpen(false)}>Cancel</Button>
          <Button onClick={addBusyBlock}><Plus className="h-4 w-4" /> Add</Button>
        </div>
      </Modal>

      {/* Add Task Modal */}
      <Modal open={addTaskOpen} title="Add a task" onClose={() => setAddTaskOpen(false)}>
        <div className="grid grid-cols-1 gap-3">
          <div>
            <div className="mb-1 text-xs font-medium text-neutral-600">Title</div>
            <Input value={taskTitle} onChange={setTaskTitle} placeholder="Study for exam" />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <div>
              <div className="mb-1 text-xs font-medium text-neutral-600">Due</div>
              <Input value={taskDue} onChange={setTaskDue} type="date" />
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-neutral-600">Priority</div>
              <select value={taskPriority} onChange={(e)=>setTaskPriority(e.target.value as TaskPriority)} className="w-full rounded-2xl border bg-white px-3 py-2 text-sm">
                <option value="low">Low</option>
                <option value="medium">Medium</option>
                <option value="high">High</option>
              </select>
            </div>
            <div>
              <div className="mb-1 text-xs font-medium text-neutral-600">Minutes</div>
              <Input value={taskEstimate} onChange={setTaskEstimate} type="number" />
            </div>
          </div>
        </div>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="outline" onClick={() => setAddTaskOpen(false)}>Cancel</Button>
          <Button onClick={addTask}><Plus className="h-4 w-4" /> Add</Button>
        </div>
      </Modal>

      {/* AI Chat Modal */}
      <Modal open={chatOpen} title="AI Chat (preview → confirm)" onClose={() => setChatOpen(false)}>
        <div className="flex h-[60vh] flex-col">
          <div className="flex-1 overflow-auto rounded-2xl border bg-neutral-50 p-3">
            <div className="space-y-2">
              {chatMessages.map((msg, idx) => (
                <div key={idx} className={`max-w-[92%] rounded-2xl px-3 py-2 text-sm ${msg.role==="user" ? "ml-auto bg-black text-white" : "bg-white border"}`}>
                  {msg.content}
                </div>
              ))}
              {chatSending ? (
                <div className="max-w-[92%] rounded-2xl border bg-white px-3 py-2 text-sm text-neutral-600">Thinking…</div>
              ) : null}
            </div>
          </div>
          <div className="mt-3 flex gap-2">
            <input
              value={chatInput}
              onChange={(e)=>setChatInput(e.target.value)}
              onKeyDown={(e)=>{ if (e.key==="Enter") sendChat(); }}
              placeholder='Example: “Exam Friday, 4h study. Gym Mon/Wed 5–6pm. Max 2 blocks/day.”'
              className="w-full rounded-2xl border bg-white px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-black/10"
            />
            <Button onClick={sendChat} disabled={chatSending}>Send</Button>
          </div>
          <div className="mt-2 text-xs text-neutral-500">
            If the AI proposes a plan, reply <span className="font-medium">confirmo</span> to apply it.
          </div>
        </div>
      </Modal>

      {/* Toast */}
      <AnimatePresence>
        {toast ? (
          <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 12 }} className="fixed bottom-4 left-1/2 z-50 -translate-x-1/2">
            <div className={`rounded-full border bg-white px-4 py-2 text-sm shadow ${toast.type==="error" ? "border-red-200" : "border-neutral-200"}`}>
              {toast.msg}
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

function ScheduleView({
  preferences, blocks, tasksById, onAddBusy, onRemoveBlock
}: {
  preferences: Preferences;
  blocks: any[];
  tasksById: Map<string, Task>;
  onAddBusy: () => void;
  onRemoveBlock: (id: string) => void;
}) {
  const start = preferences.startHour * 60;
  const end = preferences.endHour * 60;

  const hourLines: number[] = [];
  for (let m = start; m <= end; m += 60) hourLines.push(m);

  const byDay = useMemo(() => {
    const map: Record<Day, any[]> = Object.fromEntries(DAYS.map(d=>[d,[]])) as any;
    for (const b of blocks) map[b.day]?.push(b);
    for (const d of DAYS) map[d].sort((a,b2)=>a.startMin-b2.startMin);
    return map;
  }, [blocks]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <div className="rounded-3xl border bg-white p-4">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold">Weekly Schedule</div>
              <div className="text-xs text-neutral-500">Busy (gray) + Planned (black). Click a block to delete.</div>
            </div>
            <Button onClick={onAddBusy}><Plus className="h-4 w-4" /> Add busy</Button>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[900px]">
              <div className="grid grid-cols-[80px_repeat(7,1fr)] gap-2">
                <div />
                {DAYS.map((d) => <div key={d} className="px-1 text-xs font-medium text-neutral-600">{d}</div>)}

                <div className="relative">
                  {hourLines.map((m) => (
                    <div key={m} className="h-14 pr-2 text-right text-[11px] text-neutral-400">
                      {minutesToLabel(m)}
                    </div>
                  ))}
                </div>

                {DAYS.map((day) => (
                  <div key={day} className="relative rounded-2xl bg-neutral-50">
                    <div className="relative">
                      {hourLines.map((m) => <div key={m} className="h-14 border-t border-neutral-100" />)}

                      {(byDay[day] || []).map((b: any) => {
                        const top = ((b.startMin - start) / (end - start)) * (hourLines.length * 56);
                        const height = ((b.endMin - b.startMin) / (end - start)) * (hourLines.length * 56);
                        const isBusy = b.type === "busy";
                        const task = b.taskId ? tasksById.get(b.taskId) : null;
                        const label = b.label || (task ? task.title : isBusy ? "Busy" : "Planned");

                        return (
                          <button
                            key={b.id}
                            onClick={() => onRemoveBlock(b.id)}
                            title="Click to delete"
                            className={`absolute left-1 right-1 rounded-2xl px-2 py-1 text-left text-[11px] shadow-sm transition hover:shadow ${
                              isBusy ? "bg-white/70 border border-neutral-200 text-neutral-800" : "bg-black text-white"
                            }`}
                            style={{ top, height: Math.max(28, height) }}
                          >
                            <div className="line-clamp-2 font-medium">{label}</div>
                            <div className={`mt-0.5 text-[10px] ${isBusy ? "text-neutral-500" : "text-white/80"}`}>
                              {minutesToLabel(b.startMin)} – {minutesToLabel(b.endMin)}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            <Pill className="bg-neutral-50"><Clock className="h-3 w-3" /> Free range {preferences.startHour}:00–{preferences.endHour}:00</Pill>
            <Pill className="bg-neutral-50"><CheckCircle2 className="h-3 w-3" /> Max/day {preferences.maxBlocksPerDay}</Pill>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-3xl border bg-white p-4">
          <div className="text-sm font-semibold">Quick rules</div>
          <ul className="mt-2 space-y-2 text-sm text-neutral-700">
            <li>• Add busy time for classes/work/gym/sleep.</li>
            <li>• Add tasks with deadline + minutes.</li>
            <li>• Use AI Chat to propose → confirm → apply.</li>
          </ul>
        </div>
      </div>
    </div>
  );
}

function TodoView({
  tasks, plannedBlocks, onAddTask, onToggleDone, onDeleteTask
}: {
  tasks: Task[];
  plannedBlocks: PlannedBlock[];
  onAddTask: () => void;
  onToggleDone: (id: string) => void;
  onDeleteTask: (id: string) => void;
}) {
  const plannedByTask = useMemo(() => {
    const map = new Map<string, number>();
    for (const b of plannedBlocks) {
      if (!b.taskId) continue;
      map.set(b.taskId, (map.get(b.taskId) || 0) + (b.endMin - b.startMin));
    }
    return map;
  }, [plannedBlocks]);

  const sorted = useMemo(() => {
    return [...tasks].sort((a,b)=>a.dueDate.localeCompare(b.dueDate));
  }, [tasks]);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <div className="rounded-3xl border bg-white p-4">
          <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div className="text-sm font-semibold">To-Do List</div>
              <div className="text-xs text-neutral-500">Shows deadlines + estimates. Planned parts appear when you Auto-Plan.</div>
            </div>
            <Button onClick={onAddTask}><Plus className="h-4 w-4" /> Add task</Button>
          </div>

          <div className="space-y-2">
            {sorted.length === 0 ? (
              <div className="rounded-3xl border bg-neutral-50 p-6 text-center text-sm text-neutral-600">
                Add a task—or use AI Chat.
              </div>
            ) : sorted.map(t => {
              const plannedMins = plannedByTask.get(t.id) || 0;
              const pct = Math.round((plannedMins / Math.max(1, t.estimateMins)) * 100);

              return (
                <div key={t.id} className="rounded-3xl border p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <button
                        onClick={()=>onToggleDone(t.id)}
                        className={`inline-flex items-center gap-2 rounded-2xl px-2 py-1 text-sm font-semibold transition ${
                          t.done ? "bg-black text-white" : "bg-neutral-50 hover:bg-neutral-100"
                        }`}
                      >
                        <CheckCircle2 className="h-4 w-4" />
                        <span className={`truncate ${t.done ? "line-through" : ""}`}>{t.title}</span>
                      </button>

                      <div className="mt-2 flex flex-wrap gap-2">
                        <Pill className="bg-neutral-50"><CalendarDays className="h-3 w-3" /> {t.dueDate}</Pill>
                        <Pill className="bg-neutral-50"><Clock className="h-3 w-3" /> {t.estimateMins} min</Pill>
                        <Pill className="bg-neutral-50"><ClipboardList className="h-3 w-3" /> {t.priority}</Pill>
                      </div>

                      <div className="mt-3">
                        <div className="flex items-center justify-between text-xs text-neutral-500">
                          <span>Planned this week</span>
                          <span>{plannedMins} min • {pct}%</span>
                        </div>
                        <div className="mt-1 h-2 w-full rounded-full bg-neutral-100">
                          <div className="h-2 rounded-full bg-black" style={{ width: `${clamp(pct,0,100)}%` }} />
                        </div>
                      </div>

                      <div className="mt-3 rounded-2xl bg-neutral-50 p-3">
                        <div className="text-xs font-medium text-neutral-600">Planned parts</div>
                        <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-2">
                          {plannedBlocks.filter(b=>b.taskId===t.id).slice(0,6).map(b=>(
                            <div key={b.id} className="rounded-2xl border bg-white p-2 text-xs">
                              <div className="font-medium">{b.day}</div>
                              <div className="text-neutral-500">{minutesToLabel(b.startMin)} – {minutesToLabel(b.endMin)}</div>
                              <div className="mt-1 line-clamp-1 text-neutral-700">{b.label}</div>
                            </div>
                          ))}
                          {plannedBlocks.filter(b=>b.taskId===t.id).length===0 ? (
                            <div className="text-xs text-neutral-500">No blocks yet. Use Auto-Plan or AI Chat.</div>
                          ) : null}
                        </div>
                      </div>
                    </div>

                    <button onClick={()=>onDeleteTask(t.id)} className="rounded-2xl p-2 hover:bg-black/5" title="Delete">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-3xl border bg-white p-4">
          <div className="text-sm font-semibold">Tip</div>
          <div className="mt-2 text-sm text-neutral-700">
            Use AI Chat to input everything in natural language. It will show a preview first, then you confirm.
          </div>
        </div>
      </div>
    </div>
  );
}
