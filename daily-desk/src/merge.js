'use strict';
// Merge two copies of the app data (local + cloud).
// Each item has an id and updatedAt. Newer updatedAt wins.
// Deletes are kept as tombstones (deleted: true) so they sync to other devices.

const TOMBSTONE_KEEP_MS = 30 * 24 * 3600 * 1000;

function mergeLists(a = [], b = [], now = Date.now()) {
  const map = new Map();
  for (const item of [...a, ...b]) {
    const cur = map.get(item.id);
    if (!cur || (item.updatedAt || 0) > (cur.updatedAt || 0)) map.set(item.id, item);
  }
  return [...map.values()].filter(
    (it) => !(it.deleted && now - (it.updatedAt || 0) > TOMBSTONE_KEEP_MS)
  );
}

function mergeData(local, remote, now = Date.now()) {
  const l = local || {};
  const r = remote || {};
  return {
    version: 1,
    updatedAt: Math.max(l.updatedAt || 0, r.updatedAt || 0),
    checklist: mergeLists(l.checklist, r.checklist, now),
    notes: mergeLists(l.notes, r.notes, now),
  };
}

function emptyData() {
  return { version: 1, updatedAt: 0, checklist: [], notes: [] };
}

module.exports = { mergeData, mergeLists, emptyData };
