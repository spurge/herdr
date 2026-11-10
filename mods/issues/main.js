// Issues for the focused pane's repository: GitHub through `gh`, Gitea through `tea`.
// The tool is picked from the repo's remote: a host with a `tea` login uses tea, anything else gh.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, TextView } from "gpui-base";
import { spaces, panes, focused, exec, theme, run, window, layout } from "herdr";

function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on };
}
const key = () => JSON.stringify(location());

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) { const found = find(child, id); if (found) return found; }
  return null;
}
// Only fetch on the timer while the panel is actually showing issues.
function visible() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  return Boolean(panel && !panel.hidden && body?.active === "issues");
}

// git@host:owner/repo.git, ssh://git@host:22/owner/repo, https://host/owner/repo.git
function parseRemote(url) {
  url = url.trim();
  const m = /^[\w.-]+@([^:/]+):\/?(.+?)(?:\.git)?\/?$/.exec(url)
    ?? /^(?:ssh|https?|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? { host: m[1].toLowerCase(), slug: m[2] } : null;
}
const hostOf = (url) => { try { return new URL(url).hostname.toLowerCase(); } catch { return ""; } };

function ago(iso) {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (!isFinite(s)) return "";
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)}d`;
  return new Date(iso).toISOString().slice(0, 10);
}

const lastLine = (text) => (text || "").trim().split("\n").filter(Boolean).pop() || "";
// tea joins labels and assignees with spaces (a label with a space in its name splits too).
const split = (s) => (s || "").split(/[\s,]+/).filter(Boolean);

async function resolve(cwd, on) {
  const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
  if (top.code !== 0) return { error: "Not a git repository" };
  const root = top.stdout.trim();
  let remoteName = "origin", remote = await exec("git", ["remote", "get-url", remoteName], { cwd: root, on });
  if (remote.code !== 0) {
    const names = await exec("git", ["remote"], { cwd: root, on });
    remoteName = names.stdout.split("\n").find(Boolean);
    if (!remoteName) return { root, error: "This repository has no remote" };
    remote = await exec("git", ["remote", "get-url", remoteName], { cwd: root, on });
  }
  const repo = parseRemote(remote.stdout);
  if (!repo) return { root, error: `Can't read the remote ${remote.stdout.trim()}` };
  repo.remote = remoteName;
  let logins = [];
  try {
    const r = await exec("tea", ["logins", "list", "-o", "json"], { on });
    if (r.code === 0) logins = JSON.parse(r.stdout || "[]");
  } catch { /* tea isn't installed: GitHub only */ }
  const login = logins.find((l) => hostOf(l.url) === repo.host || (l.ssh_host || "").toLowerCase() === repo.host);
  if (login) return { root, ...repo, tool: "tea", login: login.name, user: login.user, site: "Gitea" };
  return { root, ...repo, tool: "gh", site: repo.host === "github.com" ? "GitHub" : repo.host };
}

// filter: "open" (all open), "mine" (open, assigned to me), "all" (recent, any state)
async function list(repo, filter, on) {
  const state = filter === "all" ? "all" : "open";
  if (repo.tool === "tea") {
    const args = ["issues", "list", "--login", repo.login, "--repo", repo.slug, "--state", state, "--limit", "40",
      "--fields", "index,state,author,url,title,body,created,updated,assignees,milestone,labels,comments", "-o", "json"];
    if (filter === "mine") {
      if (!repo.user) throw new Error(`The tea login ${repo.login} has no user name, so "Mine" can't filter. Run \`tea login edit\`.`);
      args.push("--assignee", repo.user);
    }
    const r = await exec("tea", args, { cwd: repo.root, on });
    if (r.code !== 0) throw new Error(lastLine(r.stderr || r.stdout) || "tea failed");
    return JSON.parse(r.stdout || "[]").map((i) => ({
      num: Number(i.index), title: i.title, author: i.author, url: i.url, updated: i.updated, created: i.created,
      state: (i.state || "").toLowerCase(), reason: "", body: i.body ?? "", milestone: i.milestone || "",
      comments: Number(i.comments) || 0, labels: split(i.labels), assignees: split(i.assignees),
    }));
  }
  const args = ["issue", "list", "--repo", `${repo.host}/${repo.slug}`, "--state", state, "--limit", "40",
    "--json", "number,title,author,url,updatedAt,createdAt,state,stateReason,body,labels,assignees,milestone,comments"];
  if (filter === "mine") args.push("--assignee", "@me");
  let r;
  try {
    r = await exec("gh", args, { cwd: repo.root, on });
  } catch {
    throw new Error("gh isn't installed here. Install it with `brew install gh`, then run `gh auth login`.");
  }
  if (r.code !== 0) {
    const msg = lastLine(r.stderr || r.stdout);
    if (/auth login|not logged|authentication/i.test(msg)) throw new Error(`gh isn't logged in to ${repo.host}. Run \`gh auth login${repo.host === "github.com" ? "" : ` --hostname ${repo.host}`}\`.`);
    if (/issues are disabled|has disabled issues/i.test(msg)) throw new Error("This repository has issues turned off");
    throw new Error(msg || "gh failed");
  }
  return JSON.parse(r.stdout || "[]").map((i) => ({
    num: i.number, title: i.title, author: i.author?.login ?? "", url: i.url, updated: i.updatedAt, created: i.createdAt,
    state: (i.state || "").toLowerCase(), reason: i.stateReason || "", body: i.body ?? "", milestone: i.milestone?.title ?? "",
    comments: Array.isArray(i.comments) ? i.comments.length : Number(i.comments) || 0,
    labels: (i.labels ?? []).map((l) => l.name), assignees: (i.assignees ?? []).map((a) => a.login),
  }));
}

export default class Issues extends View {
  init(_props, cx) {
    const saved = localStorage.getItem("filter");
    this.filter = ["open", "mine", "all"].includes(saved) ? saved : "open";
    this.cache = new Map(); this.issues = []; this.selected = null;
    this.refresh(cx);
    cx.timer.every(90000, (cx) => { if (visible()) this.refresh(cx, true); });
  }

  view() { return `${this.context}|${this.filter}`; }

  // force: fetch even if nothing changed; rescan: also look at the repo's remote and tea logins again.
  // From render, `rendering` is true: render already draws the new state, and notify() there throws.
  refresh(cx, force, rescan, rendering) {
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.selected = null;
      const hit = this.cache.get(this.view());
      this.repo = hit?.repo ?? null; this.issues = hit?.issues ?? []; this.error = hit?.error ?? null; this.at = hit?.at ?? 0;
      // While the panel is closed, wait: render fetches once it shows (`at` is stale).
      if (!visible() || (hit && Date.now() - hit.at < 60000)) return;
    } else if (!force) return;
    if (!cwd || this.loading) return;
    this.loading = true;
    const view = this.view(), filter = this.filter, known = this.repo;
    const reuse = !rescan && known?.root && !known.error && (cwd === known.root || cwd.startsWith(known.root + "/"));
    cx.spawn(async (cx) => {
      let entry, repo = reuse ? known : null;
      try {
        repo = repo ?? await resolve(cwd, on);
        if (repo.error) entry = { repo, issues: [], error: repo.error };
        else {
          const issues = (await list(repo, filter, on)).sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
          entry = { repo, issues, error: null };
        }
      } catch (e) { entry = { repo, issues: [], error: String(e.message ?? e) }; }
      finally { this.loading = false; }
      entry.at = Date.now();
      this.cache.set(view, entry);
      if (this.view() === view) { this.repo = entry.repo; this.issues = entry.issues; this.error = entry.error; this.at = entry.at; }
      else if (visible()) this.refresh(cx, true); // the folder or filter changed while loading
      cx.notify();
    });
    if (!rendering) cx.notify();
  }

  setFilter(filter, cx) {
    if (filter === this.filter) return;
    this.filter = filter; localStorage.setItem("filter", filter); this.selected = null;
    const hit = this.cache.get(this.view());
    this.issues = hit?.issues ?? []; this.error = hit?.error ?? null; this.at = hit?.at ?? 0;
    this.refresh(cx, true);
  }

  openUrl(url) {
    const p = window()?.platform;
    if (p === "windows") exec("cmd", ["/c", "start", "", url]);
    else exec(p === "macos" ? "open" : "xdg-open", [url]);
  }

  work(issue) {
    const repo = this.repo;
    if (!repo) return;
    const how = repo.tool === "tea"
      ? `Read it and its comments with \`tea issues ${issue.num} --comments --login ${repo.login} --repo ${repo.slug}\`.`
      : `Read it and its comments with \`gh issue view ${issue.num} --comments --repo ${repo.host}/${repo.slug}\`.`;
    run("tab.new", { name: `#${issue.num}`, folder: repo.root, argv: ["claude"],
      task: `Let's work on issue #${issue.num} "${issue.title}" (${issue.url}). ${how} Look at the code it concerns, then propose a plan before changing anything. Don't comment on or close the issue.` });
  }

  badge(text, color) {
    return div().px(5).py(0.5).rounded(4).border_1().border_color(color).text_size(10).text_color(color).flex_none().child(text);
  }

  stateMark(issue, t) {
    if (issue.state === "open") return div().size(7).rounded(4).flex_none().bg(t.ansi2);
    return div().size(7).rounded(4).flex_none().bg(issue.reason === "NOT_PLANNED" ? t.dim : t.ansi5);
  }

  closedBadge(issue, t) {
    if (issue.state === "open") return null;
    return issue.reason === "NOT_PLANNED" ? this.badge("Not planned", t.dim) : this.badge("Closed", t.ansi5);
  }

  row(issue, t) {
    const closed = this.closedBadge(issue, t);
    const meta = [issue.author, issue.assignees.length ? `→ ${issue.assignees.join(", ")}` : "", ago(issue.updated)].filter(Boolean).join(" · ");
    return v_flex().id(`issue-${issue.num}`).flex_none().px(8).py(7).gap(3).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.selected = issue.num; cx.notify(); })
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(this.stateMark(issue, t))
        .child(div().flex_1().min_w(0).truncate().text_color(closed ? t.muted : t.foreground).child(issue.title))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${issue.num}`)))
      .child(h_flex().pl(15).gap(6).items_center().min_w(0).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(meta))
        .when(issue.comments > 0, (el) => el.child(h_flex().flex_none().gap(3).items_center().child(svg("mods/issues/comment.svg").size(11)).child(String(issue.comments))))
        .children(issue.labels.slice(0, 2).map((l) => this.badge(l, t.muted)))
        .when(Boolean(closed), (el) => el.child(closed)));
  }

  action(id, label, onClick, t, primary) {
    return div().id(id).h(28).px(10).flex().items_center().rounded(7).text_size(12).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.85))
      .on_click(onClick).child(label);
  }

  detail(issue, t) {
    const closed = this.closedBadge(issue, t);
    const meta = [`#${issue.num}`, `opened by ${issue.author} ${ago(issue.created)}`, `updated ${ago(issue.updated)}`,
      issue.comments ? `${issue.comments} comment${issue.comments === 1 ? "" : "s"}` : ""].filter(Boolean).join(" · ");
    return v_flex().id("issue-detail").flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(10)
      .child(div().text_size(15).font_semibold().child(issue.title))
      .child(div().text_size(12).text_color(t.dim).child(meta))
      .child(h_flex().gap(6).flex_wrap()
        .child(issue.state === "open" ? this.badge("Open", t.ansi2) : closed)
        .when(Boolean(issue.milestone), (el) => el.child(this.badge(issue.milestone, t.accent)))
        .children(issue.assignees.map((a) => this.badge(`@${a}`, t.working)))
        .children(issue.labels.map((l) => this.badge(l, t.muted))))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.action("issue-open", "Open in browser", () => this.openUrl(issue.url), t, true))
        .when(issue.state === "open", (el) => el.child(this.action("issue-work", "Work on it with Claude", () => this.work(issue), t))))
      .child(div().h(1).flex_none().bg(t.border))
      .child(issue.body.trim()
        ? TextView.markdown(`issue-body-${issue.num}`, issue.body).selectable(true).text_size(13)
        : div().text_color(t.dim).child("No description"));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx, false, false, true);
    else if (visible() && !this.loading && Date.now() - (this.at || 0) > 90000) this.refresh(cx, true, false, true);
    const t = theme(), repo = this.repo;
    const issue = this.selected !== null ? this.issues.find((i) => i.num === this.selected) : null;
    const tab = (id, label) => div().id(`issues-filter-${id}`).h(24).px(9).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(this.filter === id ? t.selected : t.background).text_color(this.filter === id ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.setFilter(id, cx)).child(label);
    const empty = this.error || (this.loading ? "Loading issues…" : !location().cwd ? "No folder"
      : { open: "No open issues", mine: "No open issues assigned to you", all: "No issues" }[this.filter]);

    return v_flex().id("issues").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(issue), (el) => el.child(div().id("issues-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.selected = null; cx.notify(); }).child("←")))
        .child(div().font_semibold().flex_none().child("Issues"))
        .when(!issue && this.issues.length > 0, (el) => el.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).flex_none().child(String(this.issues.length))))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(repo?.slug ? `${repo.site} · ${repo.slug}` : ""))
        .child(div().id("issues-refresh").size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.refresh(cx, true, true))
          .child(this.loading ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.muted).spin(900) : "↻")))
      .when(Boolean(issue), (el) => el.child(this.detail(issue, t)))
      .when(!issue, (el) => el
        .child(h_flex().flex_none().px(10).py(6).gap(4).border_b(1).border_color(t.border)
          .child(tab("open", "Open")).child(tab("mine", "Mine")).child(tab("all", "Recent")))
        .child(v_flex().id("issues-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
          .children(this.issues.map((i) => this.row(i, t)))
          .when(!this.issues.length, (el) => el.child(div().p(8).text_size(12).text_color(this.error ? t.ansi1 : t.dim).child(empty)))
          .when(Boolean(this.error) && this.issues.length > 0, (el) => el.child(div().p(8).text_size(11).text_color(t.ansi1).child(this.error)))));
  }
}
