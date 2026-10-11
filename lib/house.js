'use strict';
// In-memory house state. Nothing is persisted: restarting the server returns
// every room to silence, which is the "ephemeral" part of the design.
//
// Rooms belong to zones. A zone is a group of rooms playing the same thing.
// Playback is described by wall-clock timestamps on the server so every
// speaker can compute where it should be in the track:
//   idle    { kind: 'idle' }
//   ambient { kind: 'ambient', scene, startedAt }
//   track   { kind: 'track', trackId, startedAt, pausedAt, duration }
// For a track, position = (serverNow - startedAt) / 1000, unless pausedAt
// (seconds) is set.

// Tracks start this far in the future so every speaker can buffer first.
const START_LEAD_MS = 1200;

const AMBIENT_SCENES = ['rain', 'ocean', 'wind', 'brown', 'drone'];

class House {
  constructor(roomNames, library, onChange) {
    this.library = library;
    this.onChange = onChange || (() => {});
    this.rooms = new Map();
    this.zones = new Map();
    this.nextZone = 1;
    for (const name of roomNames) {
      const zone = this._newZone();
      this.rooms.set(name, { name, volume: 0.6, zoneId: zone.id });
    }
    // Fallback for advancing the queue when no speaker reports the end of a
    // track (for example, nobody is listening in that zone).
    this.watchdog = setInterval(() => this._advanceFinished(), 1000);
    this.watchdog.unref?.();
  }

  _advanceFinished() {
    let changed = false;
    for (const zone of this.zones.values()) {
      const pb = zone.playback;
      if (pb.kind === 'track' && pb.pausedAt == null && pb.duration &&
          this._position(pb) > pb.duration + 3) {
        this.next(zone.id);
        changed = true;
      }
    }
    if (changed) this.onChange();
  }

  _newZone(copyFrom) {
    const id = 'z' + this.nextZone++;
    const zone = {
      id,
      queue: copyFrom ? copyFrom.queue.slice() : [],
      index: copyFrom ? copyFrom.index : 0,
      playback: copyFrom ? { ...copyFrom.playback } : { kind: 'idle' },
      sleepAt: null,
      sleepTimer: null,
    };
    this.zones.set(id, zone);
    return zone;
  }

  _room(name) {
    const r = this.rooms.get(name);
    if (!r) throw new Error(`unknown room: ${name}`);
    return r;
  }

  _zone(id) {
    const z = this.zones.get(id);
    if (!z) throw new Error(`unknown zone: ${id}`);
    return z;
  }

  _roomsIn(zoneId) {
    return [...this.rooms.values()].filter((r) => r.zoneId === zoneId);
  }

  _dropIfEmpty(zoneId) {
    if (this._roomsIn(zoneId).length === 0) {
      const z = this.zones.get(zoneId);
      if (z && z.sleepTimer) clearTimeout(z.sleepTimer);
      this.zones.delete(zoneId);
    }
  }

  _position(pb, now = Date.now()) {
    if (pb.kind !== 'track') return 0;
    if (pb.pausedAt != null) return pb.pausedAt;
    return Math.max(0, (now - pb.startedAt) / 1000);
  }

  _startTrack(zone, offsetSec = 0) {
    const trackId = zone.queue[zone.index];
    const track = this.library.get(trackId);
    if (!track) {
      zone.playback = { kind: 'idle' };
      return;
    }
    const pb = {
      kind: 'track',
      trackId,
      startedAt: Date.now() + START_LEAD_MS - offsetSec * 1000,
      pausedAt: null,
      duration: track.duration,
    };
    zone.playback = pb;
    if (!track.probed) {
      this.library.probe(track).then(() => {
        if (zone.playback === pb) {
          pb.duration = track.duration;
          this.onChange();
        }
      });
    }
  }

  // ---- commands (each returns nothing; caller broadcasts afterwards) ----

  play(zoneId, trackIds, index = 0) {
    const zone = this._zone(zoneId);
    const ids = (trackIds || []).filter((id) => this.library.get(id));
    if (ids.length === 0) throw new Error('no playable tracks');
    zone.queue = ids;
    zone.index = Math.min(Math.max(0, index | 0), ids.length - 1);
    this._startTrack(zone);
  }

  enqueue(zoneId, trackIds) {
    const zone = this._zone(zoneId);
    const ids = (trackIds || []).filter((id) => this.library.get(id));
    if (ids.length === 0) throw new Error('no playable tracks');
    const wasIdle = zone.playback.kind !== 'track';
    if (wasIdle) {
      zone.queue = ids;
      zone.index = 0;
      this._startTrack(zone);
    } else {
      zone.queue.push(...ids);
    }
  }

  ambient(zoneId, scene) {
    if (!AMBIENT_SCENES.includes(scene)) throw new Error(`unknown scene: ${scene}`);
    const zone = this._zone(zoneId);
    zone.playback = { kind: 'ambient', scene, startedAt: Date.now() };
  }

  pause(zoneId) {
    const pb = this._zone(zoneId).playback;
    if (pb.kind === 'track' && pb.pausedAt == null) pb.pausedAt = this._position(pb);
  }

  resume(zoneId) {
    const pb = this._zone(zoneId).playback;
    if (pb.kind === 'track' && pb.pausedAt != null) {
      pb.startedAt = Date.now() + START_LEAD_MS - pb.pausedAt * 1000;
      pb.pausedAt = null;
    }
  }

  seek(zoneId, seconds) {
    const pb = this._zone(zoneId).playback;
    if (pb.kind !== 'track') return;
    const s = Math.max(0, Number(seconds) || 0);
    if (pb.pausedAt != null) pb.pausedAt = s;
    else pb.startedAt = Date.now() + START_LEAD_MS - s * 1000;
  }

  next(zoneId) {
    const zone = this._zone(zoneId);
    if (zone.playback.kind !== 'track') return;
    if (zone.index + 1 < zone.queue.length) {
      zone.index++;
      this._startTrack(zone);
    } else {
      zone.playback = { kind: 'idle' };
    }
  }

  prev(zoneId) {
    const zone = this._zone(zoneId);
    if (zone.playback.kind !== 'track') return;
    // Like most players: restart the track unless we are near its start.
    if (this._position(zone.playback) < 3 && zone.index > 0) zone.index--;
    this._startTrack(zone);
  }

  // A speaker reports that its track finished. Every speaker in the zone
  // sends this, so only the first report for the current track counts.
  ended(zoneId, trackId, startedAt) {
    const zone = this.zones.get(zoneId);
    if (!zone) return false;
    const pb = zone.playback;
    if (pb.kind !== 'track' || pb.trackId !== trackId || pb.startedAt !== startedAt) return false;
    this.next(zoneId);
    return true;
  }

  stop(zoneId) {
    this._zone(zoneId).playback = { kind: 'idle' };
  }

  sleep(zoneId, minutes) {
    const zone = this._zone(zoneId);
    if (zone.sleepTimer) clearTimeout(zone.sleepTimer);
    zone.sleepTimer = null;
    zone.sleepAt = null;
    const m = Number(minutes) || 0;
    if (m <= 0) return;
    zone.sleepAt = Date.now() + m * 60000;
    zone.sleepTimer = setTimeout(() => {
      zone.sleepTimer = null;
      zone.sleepAt = null;
      if (this.zones.get(zone.id) === zone) {
        zone.playback = { kind: 'idle' };
        this.onChange();
      }
    }, m * 60000);
    zone.sleepTimer.unref?.();
  }

  volume(roomName, value) {
    const v = Number(value);
    if (!Number.isFinite(v)) throw new Error('bad volume');
    this._room(roomName).volume = Math.min(1, Math.max(0, v));
  }

  // Move a room into another zone; it picks up whatever that zone is playing.
  join(roomName, zoneId) {
    const room = this._room(roomName);
    this._zone(zoneId);
    if (room.zoneId === zoneId) return;
    const old = room.zoneId;
    room.zoneId = zoneId;
    this._dropIfEmpty(old);
  }

  // Split a room out into its own zone, keeping what it was playing.
  leave(roomName) {
    const room = this._room(roomName);
    const old = this._zone(room.zoneId);
    if (this._roomsIn(old.id).length <= 1) return;
    room.zoneId = this._newZone(old).id;
  }

  groupAll(zoneId) {
    this._zone(zoneId);
    for (const room of this.rooms.values()) this.join(room.name, zoneId);
  }

  snapshot(speakerCounts = {}) {
    const zones = [];
    for (const z of this.zones.values()) {
      const pb = z.playback;
      let track = null;
      if (pb.kind === 'track') {
        const t = this.library.get(pb.trackId);
        if (t) track = { id: t.id, title: t.title, album: t.album, artist: t.artist };
      }
      const upNext = z.queue.slice(z.index + 1, z.index + 6).map((id) => {
        const t = this.library.get(id);
        return t ? { id, title: t.title, artist: t.artist } : { id, title: '?', artist: '' };
      });
      zones.push({
        id: z.id,
        rooms: this._roomsIn(z.id).map((r) => r.name),
        playback: { ...pb, track },
        queueLength: z.queue.length,
        index: z.index,
        upNext,
        sleepAt: z.sleepAt,
      });
    }
    return {
      serverTime: Date.now(),
      scenes: AMBIENT_SCENES,
      rooms: [...this.rooms.values()].map((r) => ({
        name: r.name,
        volume: r.volume,
        zone: r.zoneId,
        speakers: speakerCounts[r.name] || 0,
      })),
      zones,
    };
  }
}

module.exports = { House, AMBIENT_SCENES, START_LEAD_MS };
