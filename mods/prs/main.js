// Pull requests for the focused pane's repository: GitHub through `gh`, Gitea through `tea`.
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
// Only fetch on the timer while the panel is actually showing PRs.
function visible() {
  const root = layout(), panel = find(root, "panel"), body = find(root, "panel-body");
  return Boolean(panel && !panel.hidden && body?.active === "prs");
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

function rollup(checks) {
  if (!checks?.length) return "";
  const bad = ["FAILURE", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"];
  if (checks.some((c) => bad.includes(c.conclusion) || bad.includes(c.state))) return "failure";
  if (checks.some((c) => (c.status && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED")) return "pending";
  return "success";
}

const lastLine = (text) => (text || "").trim().split("\n").filter(Boolean).pop() || "";

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
  if (login) return { root, ...repo, tool: "tea", login: login.name, site: "Gitea" };
  return { root, ...repo, tool: "gh", site: repo.host === "github.com" ? "GitHub" : repo.host };
}

async function list(repo, filter, on) {
  if (repo.tool === "tea") {
    const r = await exec("tea", ["pulls", "list", "--login", repo.login, "--repo", repo.slug, "--state", filter === "open" ? "open" : "all",
      "--limit", "40", "--fields", "index,state,author,url,title,head,base,updated,labels,ci,body", "-o", "json"], { cwd: repo.root, on });
    if (r.code !== 0) throw new Error(lastLine(r.stderr || r.stdout) || "tea failed");
    return JSON.parse(r.stdout || "[]").map((p) => ({
      num: Number(p.index), title: p.title, author: p.author, url: p.url, head: p.head, base: p.base, updated: p.updated,
      state: p.state, draft: /^(wip:|\[wip\])/i.test(p.title), review: "", body: p.body ?? "",
      ci: p.ci === "error" ? "failure" : p.ci === "success" || p.ci === "failure" || p.ci === "pending" ? p.ci : "",
      labels: (p.labels || "").split(/[\s,]+/).filter(Boolean),
    }));
  }
  let r;
  try {
    r = await exec("gh", ["pr", "list", "--repo", `${repo.host}/${repo.slug}`, "--state", filter === "open" ? "open" : "all", "--limit", "40",
      "--json", "number,title,author,url,headRefName,baseRefName,updatedAt,isDraft,reviewDecision,statusCheckRollup,labels,state,body"], { cwd: repo.root, on });
  } catch {
    throw new Error("gh isn't installed here. Install it with `brew install gh`, then run `gh auth login`.");
  }
  if (r.code !== 0) {
    const msg = lastLine(r.stderr || r.stdout);
    if (/auth login|not logged|authentication/i.test(msg)) throw new Error(`gh isn't logged in to ${repo.host}. Run \`gh auth login${repo.host === "github.com" ? "" : ` --hostname ${repo.host}`}\`.`);
    throw new Error(msg || "gh failed");
  }
  return JSON.parse(r.stdout || "[]").map((p) => ({
    num: p.number, title: p.title, author: p.author?.login ?? "", url: p.url, head: p.headRefName, base: p.baseRefName, updated: p.updatedAt,
    state: (p.state || "").toLowerCase(), draft: p.isDraft, review: p.reviewDecision || "", body: p.body ?? "",
    ci: rollup(p.statusCheckRollup), labels: (p.labels ?? []).map((l) => l.name),
  }));
}

export default class Prs extends View {
  init(_props, cx) {
    this.filter = localStorage.getItem("filter") === "all" ? "all" : "open";
    this.cache = new Map(); this.prs = []; this.selected = null;
    this.refresh(cx);
    cx.timer.every(90000, (cx) => { if (visible()) this.refresh(cx, true); });
  }

  view() { return `${this.context}|${this.filter}`; }

  // force: fetch even if nothing changed; rescan: also look at the repo's remote and tea logins again.
  refresh(cx, force, rescan) {
    const { cwd, on } = location(), context = key();
    if (context !== this.context) {
      this.context = context; this.selected = null; this.note = null;
      const hit = this.cache.get(this.view());
      this.repo = hit?.repo ?? null; this.prs = hit?.prs ?? []; this.error = hit?.error ?? null; this.at = hit?.at ?? 0;
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
        if (repo.error) entry = { repo, prs: [], error: repo.error };
        else {
          const prs = (await list(repo, filter, on)).sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));
          entry = { repo, prs, error: null };
        }
      } catch (e) { entry = { repo, prs: [], error: String(e.message ?? e) }; }
      finally { this.loading = false; }
      entry.at = Date.now();
      this.cache.set(view, entry);
      if (this.view() === view) { this.repo = entry.repo; this.prs = entry.prs; this.error = entry.error; this.at = entry.at; }
      else if (visible()) this.refresh(cx, true); // the folder or filter changed while loading
      cx.notify();
    });
    cx.notify();
  }

  setFilter(filter, cx) {
    if (filter === this.filter) return;
    this.filter = filter; localStorage.setItem("filter", filter); this.selected = null;
    const hit = this.cache.get(this.view());
    this.prs = hit?.prs ?? []; this.error = hit?.error ?? null; this.at = hit?.at ?? 0;
    this.refresh(cx, true);
  }

  openUrl(url) {
    const p = window()?.platform;
    if (p === "windows") exec("cmd", ["/c", "start", "", url]);
    else exec(p === "macos" ? "open" : "xdg-open", [url]);
  }

  checkout(pr, cx) {
    const repo = this.repo, { on } = location();
    if (!repo || this.busy) return;
    this.busy = true; this.note = null;
    const args = repo.tool === "tea"
      ? ["tea", ["pulls", "checkout", "--login", repo.login, "--repo", repo.slug, String(pr.num)]]
      : ["gh", ["pr", "checkout", String(pr.num), "--repo", `${repo.host}/${repo.slug}`]];
    cx.spawn(async (cx) => {
      try {
        const r = await exec(args[0], args[1], { cwd: repo.root, on });
        this.note = r.code === 0 ? { ok: true, text: `Checked out #${pr.num}` } : { ok: false, text: lastLine(r.stderr || r.stdout) || "Checkout failed" };
      } catch (e) { this.note = { ok: false, text: String(e.message ?? e) }; }
      finally { this.busy = false; cx.notify(); }
    });
    cx.notify();
  }

  review(pr) {
    const repo = this.repo;
    if (!repo) return;
    const how = repo.tool === "tea"
      ? `Read it with \`tea pr ${pr.num} --login ${repo.login} --repo ${repo.slug}\`, and get the diff with \`git fetch ${repo.remote} pull/${pr.num}/head && git diff ${repo.remote}/${pr.base}...FETCH_HEAD\`.`
      : `Read it with \`gh pr view ${pr.num} --repo ${repo.host}/${repo.slug}\` and \`gh pr diff ${pr.num} --repo ${repo.host}/${repo.slug}\`.`;
    run("tab.new", { name: `PR #${pr.num}`, folder: repo.root, argv: ["claude"],
      task: `Review pull request #${pr.num} "${pr.title}" (${pr.url}). ${how} Summarize what it changes, then list anything that looks wrong or risky. Don't post comments or change anything.` });
  }

  badge(text, color, t) {
    return div().px(5).py(0.5).rounded(4).border_1().border_color(color).text_size(10).text_color(color).flex_none().child(text);
  }

  status(pr, t) {
    if (pr.state === "merged") return this.badge("Merged", t.ansi5, t);
    if (pr.state === "closed") return this.badge("Closed", t.ansi1, t);
    return null;
  }

  ciMark(pr, t) {
    if (pr.ci === "pending") return svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900);
    if (pr.ci === "success") return div().size(7).rounded(4).flex_none().bg(t.ansi2);
    if (pr.ci === "failure") return div().size(7).rounded(4).flex_none().bg(t.ansi1);
    return div().size(7).rounded(4).flex_none().border_1().border_color(t.dim);
  }

  row(pr, t) {
    const state = this.status(pr, t);
    return v_flex().id(`pr-${pr.num}`).flex_none().px(8).py(7).gap(3).rounded(7).cursor_pointer().hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { this.selected = pr.num; this.note = null; cx.notify(); })
      .child(h_flex().gap(8).items_center().min_w(0)
        .child(this.ciMark(pr, t))
        .child(div().flex_1().min_w(0).truncate().text_color(pr.draft || state ? t.muted : t.foreground).child(pr.title))
        .child(div().flex_none().text_size(11).text_color(t.dim).child(`#${pr.num}`)))
      .child(h_flex().pl(15).gap(6).items_center().min_w(0).text_size(11).text_color(t.dim)
        .child(div().flex_1().min_w(0).truncate().child(`${pr.author} · ${pr.head} · ${ago(pr.updated)}`))
        .when(pr.draft, (el) => el.child(this.badge("Draft", t.dim, t)))
        .when(pr.review === "APPROVED", (el) => el.child(this.badge("Approved", t.ansi2, t)))
        .when(pr.review === "CHANGES_REQUESTED", (el) => el.child(this.badge("Changes", t.ansi1, t)))
        .when(Boolean(state), (el) => el.child(state)));
  }

  action(id, label, onClick, t, primary) {
    return div().id(id).h(28).px(10).flex().items_center().rounded(7).text_size(12).cursor_pointer()
      .bg(primary ? t.solid : t.raised).text_color(primary ? t.solid_foreground : t.foreground).hover((s) => s.opacity(0.85))
      .on_click(onClick).child(label);
  }

  detail(pr, t) {
    const ci = { success: ["Checks passed", t.ansi2], failure: ["Checks failed", t.ansi1], pending: ["Checks running", t.working] }[pr.ci];
    return v_flex().id("pr-detail").flex_1().min_h(0).overflow_y_scrollbar().p(14).gap(10)
      .child(div().text_size(15).font_semibold().child(pr.title))
      .child(div().text_size(12).text_color(t.dim).child(`#${pr.num} · ${pr.author} · ${pr.head} → ${pr.base} · updated ${ago(pr.updated)}`))
      .child(h_flex().gap(6).flex_wrap()
        .when(Boolean(ci), (el) => el.child(this.badge(ci[0], ci[1], t)))
        .when(pr.draft, (el) => el.child(this.badge("Draft", t.dim, t)))
        .when(pr.review === "APPROVED", (el) => el.child(this.badge("Approved", t.ansi2, t)))
        .when(pr.review === "CHANGES_REQUESTED", (el) => el.child(this.badge("Changes requested", t.ansi1, t)))
        .when(pr.review === "REVIEW_REQUIRED", (el) => el.child(this.badge("Review required", t.working, t)))
        .when(Boolean(this.status(pr, t)), (el) => el.child(this.status(pr, t)))
        .children(pr.labels.map((l) => this.badge(l, t.muted, t))))
      .child(h_flex().gap(6).flex_wrap()
        .child(this.action("pr-open", "Open in browser", () => this.openUrl(pr.url), t, true))
        .when(pr.state === "open", (el) => el.child(this.action("pr-checkout", this.busy ? "Checking out…" : "Check out", (_e, cx) => this.checkout(pr, cx), t)))
        .child(this.action("pr-review", "Review with Claude", () => this.review(pr), t)))
      .when(Boolean(this.note), (el) => el.child(div().text_size(12).text_color(this.note.ok ? t.ansi2 : t.ansi1).child(this.note.text)))
      .child(div().h(1).flex_none().bg(t.border))
      .child(pr.body.trim()
        ? TextView.markdown(`pr-body-${pr.num}`, pr.body).selectable(true).text_size(13)
        : div().text_color(t.dim).child("No description"));
  }

  render(cx) {
    if (key() !== this.context) this.refresh(cx);
    else if (visible() && !this.loading && Date.now() - (this.at || 0) > 90000) this.refresh(cx, true);
    const t = theme(), repo = this.repo;
    const pr = this.selected !== null ? this.prs.find((p) => p.num === this.selected) : null;
    const tab = (id, label) => div().id(`prs-filter-${id}`).h(24).px(9).flex().items_center().rounded(6).text_size(12).cursor_pointer()
      .bg(this.filter === id ? t.selected : t.background).text_color(this.filter === id ? t.foreground : t.muted).hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => this.setFilter(id, cx)).child(label);
    const empty = this.error || (this.loading ? "Loading pull requests…" : !location().cwd ? "No folder" : this.filter === "open" ? "No open pull requests" : "No pull requests");

    return v_flex().id("prs").size_full().min_h(0).rounded(10).overflow_hidden().bg(t.background).border_1().border_color(t.border).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .when(Boolean(pr), (el) => el.child(div().id("prs-back").w(20).cursor_pointer().text_color(t.muted).on_click((_e, cx) => { this.selected = null; this.note = null; cx.notify(); }).child("←")))
        .child(div().font_semibold().flex_none().child("Pull requests"))
        .when(!pr && this.prs.length > 0, (el) => el.child(div().px(5).py(1).rounded(4).border_1().border_color(t.border).text_size(10).text_color(t.muted).flex_none().child(String(this.prs.length))))
        .child(div().flex_1().min_w(0).truncate().text_right().text_size(12).text_color(t.dim).child(repo?.slug ? `${repo.site} · ${repo.slug}` : ""))
        .child(div().id("prs-refresh").size(22).flex_none().flex().items_center().justify_center().rounded(6).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.refresh(cx, true, true))
          .child(this.loading ? svg("mods/workspace-chrome/spinner.svg").size(12).text_color(t.muted).spin(900) : "↻")))
      .when(Boolean(pr), (el) => el.child(this.detail(pr, t)))
      .when(!pr, (el) => el
        .child(h_flex().flex_none().px(10).py(6).gap(4).border_b(1).border_color(t.border).child(tab("open", "Open")).child(tab("all", "Recent")))
        .child(v_flex().id("prs-list").flex_1().min_h(0).overflow_y_scrollbar().p(6).gap(1)
          .children(this.prs.map((p) => this.row(p, t)))
          .when(!this.prs.length, (el) => el.child(div().p(8).text_size(12).text_color(this.error ? t.ansi1 : t.dim).child(empty)))
          .when(Boolean(this.error) && this.prs.length > 0, (el) => el.child(div().p(8).text_size(11).text_color(t.ansi1).child(this.error)))));
  }
}
