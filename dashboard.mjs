import { GitHubCatalog, youtubeId } from "./github.mjs";

const find = id => document.getElementById(id);
const connection = find("connection");
const editor = find("editor");
const dialog = find("dialog");
const editForm = find("edit-form");
const fields = find("form-fields");
const saveButton = find("save");
const errorLabel = find("form-error");
const status = find("status");
const disconnectButton = find("disconnect");

let repository;
let baseSha;
let catalog;
let applyDialog;
let busy = false;
const MAX_UPLOAD = 10 * 1024 * 1024;

function element(tag, label, className) {
  const item = document.createElement(tag);
  if (label) item.textContent = label;
  if (className) item.className = className;
  return item;
}

function button(label, action, className) {
  const item = element("button", label, className);
  item.type = "button";
  item.addEventListener("click", action);
  return item;
}

function input(label, value = "", type = "text") {
  const field = element("label", label);
  const item = element("input");
  item.type = type;
  item.value = value;
  if (type === "text") {
    item.required = true;
    item.maxLength = 100;
  }
  field.append(item);
  return { field, item };
}

function openDialog(title, controls, apply, label = "Save") {
  if (busy) return;
  find("dialog-title").textContent = title;
  fields.replaceChildren(...controls);
  saveButton.textContent = label;
  errorLabel.textContent = "";
  applyDialog = apply;
  dialog.showModal();
}

function setStatus(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

function setBusy(value) {
  busy = value;
  disconnectButton.disabled = value;
  saveButton.disabled = value;
  find("cancel").disabled = value;
  editor.inert = value;
}

async function save(next, changes) {
  baseSha = await repository.save(baseSha, next, changes);
  catalog = next;
  render();
  setStatus("Saved to GitHub. Refresh the playlists on Temi after GitHub Pages finishes publishing.");
}

function removeConfirm(title, detail, action) {
  openDialog(title, [element("p", detail)], action, "Delete");
}

function actionGroup(...controls) {
  const area = element("div", "", "actions");
  area.append(...controls);
  return area;
}

function trackItem(track, ...controls) {
  const row = element("div", "", "item");
  const title = element("div");
  title.append(element("h3", track.title),
    element("p", track.kind === "youtube" ? "YouTube" : track.kind === "video" ? "Video upload" : "Audio upload", "meta"));
  row.append(title, actionGroup(...controls));
  return row;
}

function render() {
  const songs = find("songs");
  const lists = find("playlists");
  songs.replaceChildren();
  lists.replaceChildren();
  if (!catalog.tracks.length) songs.append(element("p", "Add a song to start your library.", "empty"));
  if (!catalog.playlists.length) lists.append(element("p", "Create a playlist for Temi.", "empty"));
  const tracks = new Map(catalog.tracks.map(track => [track.id, track]));
  for (const track of catalog.tracks) {
    songs.append(trackItem(track, button("Edit", () => editSong(track)),
      button("Delete", () => deleteSong(track), "danger")));
  }
  for (const playlist of catalog.playlists) {
    const section = element("section", "", "playlist");
    const header = element("div", "", "section-heading");
    header.append(element("h3", playlist.title), actionGroup(button("Edit", () => editPlaylist(playlist)),
      button("Delete", () => deletePlaylist(playlist), "danger")));
    section.append(header);
    if (!playlist.trackIds.length) section.append(element("p", "No songs in this playlist.", "empty"));
    playlist.trackIds.forEach((id, index) => {
      const track = tracks.get(id);
      if (!track) return;
      const up = button("↑", () => moveSong(playlist, index, -1));
      const down = button("↓", () => moveSong(playlist, index, 1));
      up.setAttribute("aria-label", "Move " + track.title + " up");
      down.setAttribute("aria-label", "Move " + track.title + " down");
      up.disabled = index === 0;
      down.disabled = index === playlist.trackIds.length - 1;
      section.append(trackItem(track, up, down));
    });
    lists.append(section);
  }
}

function readMedia(file, trackId) {
  const extension = file?.name.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1];
  const kind = ["mp3", "m4a", "wav", "ogg", "aac"].includes(extension) ? "audio"
    : ["mp4", "webm"].includes(extension) ? "video" : null;
  if (!kind || !file.size || file.size > MAX_UPLOAD) {
    throw new Error("Choose an MP3, M4A, WAV, OGG, AAC, MP4 or WebM file up to 10 MB.");
  }
  const path = "media/" + trackId + "-" + crypto.randomUUID() + "." + extension;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve({ path, kind, base64: String(reader.result).split(",", 2)[1] });
    reader.onerror = () => reject(new Error("The selected file could not be read."));
    reader.readAsDataURL(file);
  });
}

function editSong(track) {
  const name = input("Song title", track?.title);
  const link = input("YouTube video link", "", "url");
  const file = input("Music file", "", "file");
  file.item.accept = ".mp3,.m4a,.wav,.ogg,.aac,.mp4,.webm";

  const sourceField = element("label", "Source");
  const source = element("select");
  if (track) {
    const keep = element("option", "Keep current source");
    keep.value = "keep";
    source.append(keep);
  }
  for (const [value, label] of [["youtube", "YouTube link"], ["upload", "Upload a file"]]) {
    const option = element("option", label);
    option.value = value;
    source.append(option);
  }
  sourceField.append(source);
  function showSource() {
    link.field.hidden = source.value !== "youtube";
    link.item.required = !link.field.hidden;
    file.field.hidden = source.value !== "upload";
    file.item.required = !file.field.hidden;
  }
  source.addEventListener("change", showSource);
  showSource();

  openDialog(track ? "Edit song" : "Add song", [name.field, sourceField, link.field, file.field], async () => {
    const title = name.item.value.trim();
    if (!title) throw new Error("Enter a song title.");
    const id = track?.id || crypto.randomUUID();
    let updated = { ...track, id, title };
    let upload;
    const remove = [];
    if (source.value === "youtube") {
      const videoId = youtubeId(link.item.value.trim());
      if (!videoId) throw new Error("Paste a link to a single YouTube video.");
      updated = { id, title, kind: "youtube", videoId };
    } else if (source.value === "upload") {
      upload = await readMedia(file.item.files[0], id);
      updated = { id, title, kind: upload.kind, src: upload.path };
    }
    if (track?.src && track.src !== updated.src) remove.push(track.src);
    const tracks = track ? catalog.tracks.map(song => song.id === id ? updated : song)
      : [...catalog.tracks, updated];
    await save({ ...catalog, tracks }, { upload, remove, message: track ? "Update music track" : "Add music track" });
  });
}

function deleteSong(track) {
  removeConfirm("Delete song", "This removes the song from the library and every playlist.", async () => {
    const tracks = catalog.tracks.filter(song => song.id !== track.id);
    const playlists = catalog.playlists.map(list => ({ ...list, trackIds: list.trackIds.filter(id => id !== track.id) }));
    await save({ ...catalog, tracks, playlists }, { remove: track.src ? [track.src] : [], message: "Delete music track" });
  });
}

function editPlaylist(playlist) {
  const name = input("Playlist name", playlist?.title);
  const controls = [name.field, element("h3", "Songs in this playlist")];
  const checked = new Map();
  for (const track of catalog.tracks) {
    const label = element("label", "", "check");
    const box = element("input");
    box.type = "checkbox";
    box.checked = playlist?.trackIds.includes(track.id) ?? false;
    label.append(box, element("span", track.title));
    controls.push(label);
    checked.set(track.id, box);
  }
  if (!checked.size) controls.push(element("p", "Add songs to the library to include them here.", "empty"));
  openDialog(playlist ? "Edit playlist" : "Create playlist", controls, async () => {
    const title = name.item.value.trim();
    if (!title) throw new Error("Enter a playlist name.");
    const id = playlist?.id || crypto.randomUUID();
    const trackIds = (playlist?.trackIds || []).filter(trackId => checked.get(trackId)?.checked);
    for (const [trackId, box] of checked) if (box.checked && !trackIds.includes(trackId)) trackIds.push(trackId);
    const updated = { id, title, trackIds };
    const playlists = playlist ? catalog.playlists.map(list => list.id === id ? updated : list)
      : [...catalog.playlists, updated];
    await save({ ...catalog, playlists }, { message: playlist ? "Update music playlist" : "Create music playlist" });
  });
}

function deletePlaylist(playlist) {
  removeConfirm("Delete playlist", "This removes the playlist. Its songs stay in the library.", async () => {
    const playlists = catalog.playlists.filter(list => list.id !== playlist.id);
    await save({ ...catalog, playlists }, { message: "Delete music playlist" });
  });
}

async function moveSong(playlist, index, offset) {
  if (busy) return;
  const position = index + offset;
  if (position < 0 || position >= playlist.trackIds.length) return;
  const trackIds = [...playlist.trackIds];
  [trackIds[index], trackIds[position]] = [trackIds[position], trackIds[index]];
  const playlists = catalog.playlists.map(list => list.id === playlist.id ? { ...list, trackIds } : list);
  setBusy(true);
  setStatus("Saving song order…");
  try {
    await save({ ...catalog, playlists }, { message: "Reorder music playlist" });
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    setBusy(false);
  }
}

connection.addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  const values = new FormData(connection);
  setBusy(true);
  connection.querySelector("button").disabled = true;
  setStatus("Connecting to GitHub…");
  try {
    const client = new GitHubCatalog(values.get("repository").trim(), values.get("branch").trim(), values.get("token").trim());
    const data = await client.load();
    repository = client;
    catalog = data.catalog;
    baseSha = data.sha;
    connection.elements.namedItem("token").value = "";
    connection.hidden = true;
    disconnectButton.hidden = false;
    editor.hidden = false;
    render();
    setStatus("Connected to " + values.get("repository").trim() + ".");
  } catch (error) {
    setStatus(error.message, true);
  } finally {
    connection.querySelector("button").disabled = false;
    setBusy(false);
  }
});

disconnectButton.addEventListener("click", () => {
  repository = catalog = baseSha = undefined;
  editor.hidden = disconnectButton.hidden = true;
  connection.hidden = false;
  setStatus("");
});

editForm.addEventListener("submit", async event => {
  event.preventDefault();
  if (busy) return;
  errorLabel.textContent = "";
  setBusy(true);
  const label = saveButton.textContent;
  saveButton.textContent = "Saving…";
  try {
    await applyDialog();
    dialog.close();
  } catch (error) {
    errorLabel.textContent = error.message;
  } finally {
    saveButton.textContent = label;
    setBusy(false);
  }
});

dialog.addEventListener("cancel", event => { if (busy) event.preventDefault(); });
dialog.addEventListener("close", () => {
  applyDialog = undefined;
  fields.replaceChildren();
});
find("cancel").addEventListener("click", () => dialog.close());
find("add-song").addEventListener("click", () => editSong());
find("add-list").addEventListener("click", () => editPlaylist());

if (location.hostname.endsWith(".github.io")) {
  const owner = location.hostname.split(".")[0];
  const repo = location.pathname.split("/")[1] || location.hostname;
  connection.elements.namedItem("repository").value = owner + "/" + repo;
}
