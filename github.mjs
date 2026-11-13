const catalogPath = "library.json";

export function emptyCatalog() {
  return { version: 1, tracks: [], playlists: [] };
}

export function decodeCatalog(encoded) {
  const bytes = Uint8Array.from(atob(encoded.replace(/\s/g, "")), char => char.charCodeAt(0));
  const catalog = JSON.parse(new TextDecoder().decode(bytes));
  if (catalog?.version !== 1 || !Array.isArray(catalog.tracks) || !Array.isArray(catalog.playlists)) {
    throw new Error("This repository does not contain a supported music library.");
  }
  return catalog;
}

export function youtubeId(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    let id;
    if (host === "youtu.be") id = url.pathname.slice(1);
    else if (["youtube.com", "www.youtube.com", "m.youtube.com"].includes(host)) {
      id = url.pathname === "/watch" ? url.searchParams.get("v") : url.pathname.match(/^\/(?:shorts|embed)\/([^/]+)\/?$/)?.[1];
    }
    return /^[\w-]{11}$/.test(id || "") ? id : null;
  } catch {
    return null;
  }
}

export class GitHubCatalog {
  constructor(repository, branch, token) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || repository.split("/").some(part => /^\.{1,2}$/.test(part))) {
      throw new Error("Enter the repository as owner/repository.");
    }
    if (!/^[\w./-]+$/.test(branch) || branch.includes("..") || branch.startsWith("/") || branch.endsWith("/")) {
      throw new Error("Enter a valid branch name.");
    }
    this.base = "https://api.github.com/repos/" + repository;
    this.branch = branch.split("/").map(encodeURIComponent).join("/");
    this.token = token;
  }

  async request(path, method = "GET", body) {
    const response = await fetch(this.base + path, {
      method,
      cache: "no-store",
      redirect: "error",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: "Bearer " + this.token,
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    if (!response.ok) {
      const messages = {
        401: "GitHub rejected the token. Check that it is current.",
        403: "GitHub denied the request. Check the token permissions, branch rules or rate limit.",
        404: "GitHub could not find the repository, branch or library file with this token."
      };
      throw new Error(messages[response.status] || ("GitHub request failed (" + response.status + ")."));
    }
    return response.json();
  }

  async head() {
    return (await this.request("/git/ref/heads/" + this.branch)).object.sha;
  }

  async load() {
    const sha = await this.head();
    const file = await this.request("/contents/" + catalogPath + "?ref=" + sha);
    return { sha, catalog: decodeCatalog(file.content || "") };
  }

  async save(baseSha, catalog, { upload, remove = [], message }) {
    const content = JSON.stringify(catalog, null, 2) + "\n";
    if (new TextEncoder().encode(content).length > 750_000) throw new Error("This pilot library is too large to save.");
    if (await this.head() !== baseSha) throw new Error("The branch changed. Reconnect to load the latest library before retrying.");
    const parent = await this.request("/git/commits/" + baseSha);
    const tree = [{ path: catalogPath, mode: "100644", type: "blob", content }];
    for (const path of new Set(remove)) {
      if (!/^media\/[a-f0-9-]+\.[a-z0-9]+$/.test(path)) throw new Error("Invalid media path.");
      tree.push({ path, mode: "100644", type: "blob", sha: null });
    }
    if (upload) {
      const blob = await this.request("/git/blobs", "POST", { content: upload.base64, encoding: "base64" });
      tree.push({ path: upload.path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const nextTree = await this.request("/git/trees", "POST", { base_tree: parent.tree.sha, tree });
    const commit = await this.request("/git/commits", "POST", { message, tree: nextTree.sha, parents: [baseSha] });
    try {
      await this.request("/git/refs/heads/" + this.branch, "PATCH", { sha: commit.sha, force: false });
    } catch (error) {
      const latest = await this.head().catch(() => null);
      if (latest === commit.sha) return commit.sha;
      if (latest && latest !== baseSha) throw new Error("The branch changed. Reconnect before retrying.");
      throw error;
    }
    return commit.sha;
  }
}
