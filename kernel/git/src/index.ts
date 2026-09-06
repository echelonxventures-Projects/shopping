// @aether/kernel-git — Git as ECR data (user mandate: "GIT must be derived
// Entity, Context, Relationship, Configuration").
//
// Git itself becomes kernel data: Repository/Branch/Commit/Tag/Remote are
// entity types; branch-of/parent-of/tags/tracks relationships; deploy context
// frames (which branch + remote + runtime target = deployment context); remotes
// and policies arrive as configuration (packs), never hardcoded.
//
// Tier-0 mechanics only: this module EXECUTES git via child_process and maps
// results into ECR entities. No repository URLs, branch names, or policies are
// literals — everything comes from GitConfig (pack data).

import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---- Entities (ECR) ----
export interface Repository {
  id: string;
  localPath: string;
  defaultBranch: string;
}

export interface Commit {
  id: string; // sha
  sha: string;
  message: string;
  author: string;
  timestamp: string;
  refs: string[]; // branches/tags pointing here
}

export interface Branch {
  id: string;
  name: string;
  head: string; // sha
  remoteTracking?: string;
}

export interface Tag {
  id: string;
  name: string;
  sha: string;
}

// ---- Relationships ----
export interface GitRelationship {
  kind: 'parent-of' | 'branch-of' | 'tags' | 'tracks-remote' | 'deployed-from';
  from: string;
  to: string;
}

// ---- Context: a GitContextFrame selects repository + ref + view ----
export interface GitContextFrame {
  repository: string; // repository id from config
  ref?: string; // branch/tag/sha — defaults to default branch
  since?: string;
}

// ---- Configuration (pack data) ----
export interface GitConfig {
  repositories: Array<{
    id: string;
    localPath: string;
    defaultBranch: string;
    remotes: Array<{ name: string; url: string; push: boolean }>;
  }>;
  policies?: {
    protectedBranches?: string[];
    conventionalCommits?: boolean;
    requireUpstream?: boolean;
  };
}

export class GitStore {
  private config: GitConfig;
  private gitPath: string;

  constructor(config: GitConfig, repoRoot?: string) {
    this.config = config;
    this.gitPath = repoRoot ?? join(dirname(fileURLToPath(import.meta.url)), '../../..');
  }

  repository(id: string): Repository {
    const r = this.config.repositories.find((x) => x.id === id);
    if (!r) throw new Error(`Unknown repository "${id}" — register it in GitConfig (pack data)`);
    return { id: r.id, localPath: r.localPath, defaultBranch: r.defaultBranch };
  }

  private git(args: string[]): string {
    return execFileSync('git', args, { cwd: this.gitPath, encoding: 'utf8' }).trim();
  }

  /** Commit entity with U²D-compatible identity: sha as the universal ID */
  commits(frame: GitContextFrame, limit = 20): Commit[] {
    const repo = this.repository(frame.repository);
    const ref = frame.ref ?? repo.defaultBranch;
    const out = this.git(['log', `--max-count=${limit}`, '--pretty=format:%H%x1f%an%x1f%at%x1f%s%x1f%D', ref]);
    if (!out) return [];
    return out.split('\n').map((line) => {
      const [sha, author, ts, message, refs] = line.split('\x1f');
      return {
        id: `commit:${sha}`,
        sha: sha!,
        author: author!,
        timestamp: new Date(Number(ts) * 1000).toISOString(),
        message: message!,
        refs: refs ? refs.split(', ').map((r) => r.replace('HEAD -> ', '').replace('origin/', '')).filter(Boolean) : [],
      };
    });
  }

  branches(frame: GitContextFrame): Branch[] {
    const out = this.git(['branch', '-vv', '--no-color']);
    return out.split('\n').filter(Boolean).map((line) => {
      const active = line.startsWith('*');
      const cleaned = line.replace(/^\*?\s+/, '');
      const [name, rest] = cleaned.split(/\s+/, 2) as [string, string | undefined];
      const head = (rest ?? '').replace(/\[.*$/, '').trim();
      const tracking = (cleaned.match(/\[([^\]]+)\]/) ?? [])[1];
      return {
        id: `branch:${name}`,
        name: name!,
        head: head || 'HEAD',
        remoteTracking: tracking ? `remote:${tracking.split(':')[0]}` : undefined,
        // active flag implicit via `git rev-parse --abbrev-ref HEAD` if needed
      };
    });
  }

  tags(frame: GitContextFrame): Tag[] {
    const out = this.git(['tag', '--list']);
    return out.split('\n').filter(Boolean).map((name) => {
      const sha = this.git(['rev-list', '-1', name!]);
      return { id: `tag:${name}`, name: name!, sha };
    });
  }

  /** parent-of relationships: commit → its parents (from sha only for linear v0) */
  relationships(frame: GitContextFrame, limit = 10): GitRelationship[] {
    const rels: GitRelationship[] = [];
    const commits = this.commits(frame, limit);
    for (let i = 0; i < commits.length - 1; i++) {
      rels.push({ kind: 'parent-of', from: commits[i]!.id, to: commits[i + 1]!.id });
    }
    for (const b of this.branches(frame)) {
      rels.push({ kind: 'branch-of', from: b.id, to: frame.repository });
    }
    for (const t of this.tags(frame)) {
      rels.push({ kind: 'tags', from: t.id, to: `commit:${t.sha}` });
    }
    const repo = this.config.repositories.find((r) => r.id === frame.repository);
    for (const remote of repo?.remotes ?? []) {
      rels.push({ kind: 'tracks-remote', from: `${frame.repository}:${remote.name}`, to: remote.url });
    }
    return rels;
  }

  /** remotes from CONFIG (never literals) */
  remotes(frame: GitContextFrame): Array<{ name: string; url: string }> {
    const repo = this.config.repositories.find((r) => r.id === frame.repository);
    return repo?.remotes ?? [];
  }

  /** working-tree status mapped as entity mutations pending commit */
  status(frame: GitContextFrame): Array<{ path: string; state: string }> {
    const out = this.git(['status', '--porcelain']);
    if (!out) return [];
    return out.split('\n').filter(Boolean).map((line) => ({
      state: line.slice(0, 2).trim() || 'modified',
      path: line.slice(3).trim(),
    }));
  }

  /** deployment context: which commit is HEAD of the deploy ref */
  deployContext(frame: GitContextFrame): { repository: string; ref: string; sha: string; message: string } {
    const repo = this.repository(frame.repository);
    const ref = frame.ref ?? repo.defaultBranch;
    const sha = this.git(['rev-parse', ref]);
    const message = this.git(['log', '-1', '--pretty=format:%s', ref]);
    return { repository: frame.repository, ref, sha, message };
  }
}
