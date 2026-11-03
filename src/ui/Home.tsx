/**
 * The startup screen: every project in projects/ as a card with a live
 * thumbnail, plus New project, the sample and templates. The editor opens
 * only once a project is chosen, so launching never saves over a project.
 */
import { useEffect, useRef, useState } from "react";
import { evaluateComposition } from "../core/evaluate";
import { parseProject } from "../core/project-io";
import type { Asset, Project } from "../core/types";
import { SvgRenderer } from "../render/renderer";
import { createProject, freeName, listLibrary, listProjects, newFromTemplate, openProject, openSample } from "./api";
import { toast } from "./state";

type Entry = { name: string; modified: number };

function ago(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

/** One frame from the middle of the project's active comp, drawn by the editor's own renderer. */
function Thumbnail({ name, project }: { name: string; project: Project }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const comp = project.compositions.find((c) => c.id === project.activeCompId) ?? project.compositions[0];
    const assetUrl = (a: Asset) => (/^(data|blob|https?):/.test(a.src) ? a.src : `/projects/${encodeURIComponent(name)}/${a.src}`);
    const r = new SvgRenderer(ref.current!);
    try {
      r.render(evaluateComposition(project, comp, comp.duration / 2, { includeReference: false, assetUrl }));
      r.svg.setAttribute("width", "100%");
      r.svg.setAttribute("height", "100%");
    } catch {
      /* a broken project still gets a card */
    }
    return () => r.destroy();
  }, [name, project]);
  return <div className="thumb-svg" ref={ref} />;
}

function ProjectCard({ entry, last }: { entry: Entry; last: boolean }) {
  const [project, setProject] = useState<Project | null | "error">(null);
  useEffect(() => {
    fetch(`/api/project?name=${encodeURIComponent(entry.name)}`)
      .then((r) => (r.ok ? r.text() : Promise.reject()))
      .then((t) => setProject(parseProject(t)))
      .catch(() => setProject("error"));
  }, [entry.name, entry.modified]);
  const comp = project && project !== "error" ? (project.compositions.find((c) => c.id === project.activeCompId) ?? project.compositions[0]) : null;
  return (
    <button className="card" data-project={entry.name} onClick={() => openProject(entry.name).then((ok) => ok || toast(`Cannot open ${entry.name}`, "error"))}>
      <div className="thumb">
        {project && project !== "error" && <Thumbnail name={entry.name} project={project} />}
        {project === "error" && <span className="muted small">Can't read this project</span>}
        {last && <span className="badge">Last opened</span>}
      </div>
      <div className="card-name">{entry.name}</div>
      <div className="card-meta muted small">
        {ago(entry.modified)}
        {comp && ` · ${comp.width}×${comp.height} · ${+comp.duration.toFixed(2)} s`}
      </div>
    </button>
  );
}

export function Home() {
  const [projects, setProjects] = useState<Entry[] | null>(null);
  const [templates, setTemplates] = useState<Entry[]>([]);
  const [query, setQuery] = useState("");
  const [newName, setNewName] = useState("");
  let last: string | null = null;
  try {
    last = localStorage.getItem("mge:last");
  } catch {
    /* private mode */
  }
  useEffect(() => {
    listProjects().then((l) => {
      setProjects(l);
      setNewName(freeName(l));
    });
    listLibrary("template").then(setTemplates);
  }, []);
  const shown = (projects ?? []).filter((p) => p.name.toLowerCase().includes(query.trim().toLowerCase()));
  const create = () => {
    const name = newName.trim().replace(/^\.+/, "").slice(0, 80);
    if (name) createProject(name);
  };
  return (
    <div className="home" data-testid="home">
      <header className="topbar">
        <strong className="brand">◆ Motion</strong>
        <span className="muted">Projects</span>
        <span className="spacer" />
        <input className="home-search" type="search" placeholder="Search projects" value={query} onChange={(e) => setQuery(e.target.value)} />
      </header>
      <div className="home-body">
        <section className="home-actions">
          <form
            className="home-new"
            onSubmit={(e) => {
              e.preventDefault();
              create();
            }}
          >
            <input className="home-new-name" value={newName} autoFocus title="Name of the new project (its folder in projects/)" onChange={(e) => setNewName(e.target.value.replace(/[^a-zA-Z0-9 _.-]/g, "_"))} />
            <button className="primary" type="submit" disabled={!newName.trim()}>New project</button>
          </form>
          <button onClick={() => openSample()} title="The sample lower third, as a new project">Open sample</button>
          {templates.length > 0 && (
            <select
              value=""
              title="Start a new project from a saved template"
              onChange={(e) => {
                const t = e.target.value;
                newFromTemplate(t, t).catch((er) => toast(er.message, "error"));
              }}
            >
              <option value="" disabled>New from template…</option>
              {templates.map((t) => (
                <option key={t.name} value={t.name}>{t.name}</option>
              ))}
            </select>
          )}
        </section>
        {projects === null ? (
          <p className="muted">Loading projects…</p>
        ) : projects.length === 0 ? (
          <p className="muted">No projects yet. Name one above and press New project, or open the sample.</p>
        ) : (
          <>
            <div className="home-grid">
              {shown.map((p) => (
                <ProjectCard key={p.name} entry={p} last={p.name === last} />
              ))}
            </div>
            {shown.length === 0 && <p className="muted">No project matches "{query}".</p>}
          </>
        )}
      </div>
    </div>
  );
}
