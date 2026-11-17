// Closed tabs: every tab you closed (its terminal killed), newest first.
// A Claude Code session that ran in it is found by its title (Claude names the
// terminal after the session's ai-title) and resumed; a plain shell reopens in
// its last folder. Type to filter, ↑/↓ to pick, Enter to restore, ctrl+d to
// drop one from the list, Esc to leave. Opened with mod.open:closed-tabs.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, ScrollHandle } from "gpui-base";
import { spaces, agents, run, hc, exec, home, theme, props, closeOverlay, shared, setShared, checking } from "herdr";

const MAX = 60;
const HIDDEN = "closed-tabs.hidden";

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function projectDir(cwd) {
  return home() + "/.claude/projects/" + cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// Newest session file in the cwd's Claude project whose ai-title is this title,
// preferring the one last written closest to when the tab closed.
// Only files written since the tab opened ($3, seconds) are searched.
const FIND = 'cd "$1" 2>/dev/null || exit 0; for f in *.jsonl; do [ -f "$f" ] || continue; m=$(stat -f %m "$f"); [ "$m" -ge "$3" ] && grep -q -F -- "$2" "$f" && echo "$m $f"; done; true';

async function findSession(cwd, title, createdMs, finishedMs) {
  if (!title || !cwd) return null;
  const r = await exec("sh", ["-c", FIND, "sh", projectDir(cwd), '"aiTitle":' + JSON.stringify(title), String(Math.floor(createdMs / 1000))], { timeout: 15000 });
  let best = null;
  for (const line of r.stdout.split("\n")) {
    const m = line.match(/^(\d+) (.+)\.jsonl$/);
    if (!m) continue;
    const d = Math.abs(Number(m[1]) * 1000 - finishedMs);
    if (!best || d < best.d) best = { id: m[2], d };
  }
  return best ? best.id : null;
}

export default class ClosedTabs extends View {
  init(_props, cx) {
    this.items = null;
    this.error = null;
    this.filter = "";
    this.at = 0;
    this.previews = {};
    this.scroll = ScrollHandle.new();
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Filter closed tabs…" });
    this.input.on("change", (_e, cx) => { this.filter = this.input.value(); this.at = 0; cx.notify(); });
    this.input.on("submit", () => this.restore(this.rows()[this.at]));
    this.input.focus();
    cx.timer.after(600, () => this.input.focus());
    if (checking()) { this.items = []; return; }
    cx.spawn(async (cx) => {
      try {
        this.items = await this.load();
        cx.notify();
        this.peek(cx);
        await this.resolveSessions();
      } catch (e) { this.error = String(e); this.items = this.items ?? []; }
      cx.notify();
    });
  }

  async load() {
    const r = await hc(["ls", "--all", "--json"]);
    const all = JSON.parse(r.stdout).terminals ?? [];
    const dead = all.filter((x) => x.state === "finished" && !x.parent && x.reason === "killed");
    const got = await Promise.all(dead.map(async (x) => {
      try { const g = await hc(["get", x.address, "--json"]); return JSON.parse(g.stdout); } catch { return null; }
    }));
    const items = got.filter((g) => g && g.labels && g.labels["herdr.space"])
      .sort((a, b) => (b.finished_ms ?? 0) - (a.finished_ms ?? 0))
      .slice(0, MAX)
      .map((g) => ({
        address: g.address,
        cwd: g.cwd,
        shell: (g.argv && g.argv[0]) || "/bin/zsh",
        title: g.title || "",
        where: g.labels.where || "",
        space: g.labels["herdr.space"],
        created: g.created_ms ?? 0,
        finished: g.finished_ms ?? 0,
        session: null,
      }));
    return items;
  }

  async resolveSessions() {
    const items = this.items ?? [];
    await Promise.all(items.map(async (it) => {
      try { it.session = await findSession(it.cwd, it.title, it.created, it.finished); } catch {}
    }));
    // One row per Claude session: its latest closed tab.
    const seen = new Set();
    this.items = items.filter((it) => !it.session || (seen.has(it.session) ? false : (seen.add(it.session), true)));
    this.resolved = true;
  }

  rows() {
    const hidden = new Set(shared(HIDDEN) ?? []);
    const f = this.filter.toLowerCase();
    return (this.items ?? []).filter((it) => !hidden.has(it.address))
      .filter((it) => !f || [it.title, it.where, it.cwd].join(" ").toLowerCase().includes(f));
  }

  peek(cx) {
    const it = this.rows()[this.at];
    if (!it || this.previews[it.address] !== undefined) return;
    this.previews[it.address] = null;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", it.address, "--lines", "40"]);
        const lines = r.stdout.split("\n").filter((l) => l.trim() && !l.startsWith("[hc]") && !/^[─━]+$/.test(l.trim()));
        this.previews[it.address] = lines.slice(-10).join("\n");
      } catch { this.previews[it.address] = ""; }
      cx.notify();
    });
  }

  close() { closeOverlay(props().overlay); }

  hide(it) {
    if (!it) return;
    setShared(HIDDEN, [...(shared(HIDDEN) ?? []), it.address].slice(-500));
  }

  restore(it) {
    if (!it) return;
    this.close();
    const space = spaces().find((s) => s.id === it.space);
    const argv = it.session ? [it.shell, "-lc", "claude --resume " + it.session + "; exec " + it.shell + " -l"] : undefined;
    const tabName = (it.where.split(" / ")[1] || "").trim();
    const name = tabName && !/^(tab )?\d+$/.test(tabName) ? tabName : undefined;
    if (space) run("tab.new", { space: space.id, folder: it.cwd, argv, name });
    else run("space.new", { folder: it.cwd, argv, tab: name });
    this.hide(it);
  }

  render() {
    const t = theme();
    const rows = this.rows();
    this.at = Math.max(0, Math.min(this.at, rows.length - 1));
    const sel = rows[this.at];
    const liveTitles = new Set(agents().map((a) => a.title));
    const spaceName = (it) => spaces().find((s) => s.id === it.space)?.name ?? (it.where.split(" / ")[0] || "?") + " (closed)";

    const row = (it, i) => {
      const on = i === this.at;
      const open = it.session && liveTitles.has(it.title);
      return h_flex().id("ct-" + it.address).mx(4).px(10).py(6).rounded(7).gap(10).items_center().cursor_pointer()
        .when(on, (el) => el.bg(t.hover))
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { if (this.at === i) this.restore(it); else { this.at = i; this.peek(cx); cx.notify(); } })
        .child(div().w(14).flex_none().text_color(it.session ? t.accent : t.dim).child(it.session ? "✳" : "›"))
        .child(v_flex().flex_1().min_w(0).gap(2)
          .child(div().truncate().text_color(t.foreground).child(it.title || (it.session ? "Claude session" : "shell")))
          .child(div().truncate().text_size(11).text_color(t.dim).child(spaceName(it) + " · " + it.cwd.replace(home(), "~"))))
        .when(open, (el) => el.child(div().text_size(11).text_color(t.done).child("open now")))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(ago(it.finished)));
    };

    const preview = sel ? this.previews[sel.address] : null;
    return v_flex().id("closed-tabs").track_focus(this.handle).size_full().min_h(0).p(18).gap(10).bg(t.popover).text_size(13)
      .on_key_down((e, cx) => {
        const k = e.key;
        if (k === "escape") return this.close();
        if (k === "down") this.at = Math.min(this.at + 1, rows.length - 1);
        else if (k === "up") this.at = Math.max(this.at - 1, 0);
        else if (k === "d" && e.modifiers.control) this.hide(sel);
        else return;
        this.scroll.scroll_to_item(this.at);
        this.peek(cx);
        cx.stop_propagation();
        cx.notify();
      })
      .child(h_flex().items_center()
        .child(div().flex_1().text_size(15).font_semibold().text_color(t.foreground).child("Closed tabs"))
        .child(div().text_size(11).text_color(t.dim).mr(8).child("↵ restore · ⌃D forget"))
        .child(div().id("ct-esc").px(6).py(2).rounded(5).text_size(11).text_color(t.dim).cursor_pointer()
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click(() => this.close()).child("Esc")))
      .child(h_flex().h(36).flex_none().px(10).gap(8).items_center().rounded(9).border_1().border_color(t.accent).bg(t.background)
        .child(svg("mods/workspace-chrome/search.svg").size(15).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.8).text_color(t.foreground)))
      .child(this.items === null
        ? div().p(10).text_color(t.dim).child("Looking through closed terminals…")
        : rows.length === 0
          ? div().p(10).text_color(t.dim).child(this.error ? "Couldn't list terminals: " + this.error : "No closed tabs.")
          : v_flex().id("ct-list").h(Math.min(400, rows.length * 48)).flex_none().overflow_y_scrollbar().track_scroll(this.scroll).children(rows.map(row)))
      .when(!!sel, (el) => el.child(
        v_flex().flex_none().h(170).p(10).gap(4).rounded(8).bg(t.background).border_1().border_color(t.border).overflow_hidden()
          .child(div().text_size(11).text_color(t.dim).child(sel.session ? "resumes: claude --resume " + sel.session : this.resolved ? "opens a shell in " + sel.cwd.replace(home(), "~") : "looking for its Claude session…"))
          .child(div().flex_1().min_h(0).overflow_hidden().text_size(11).text_color(t.muted).child(preview == null ? "…" : preview || "(empty screen)"))));
  }
}
