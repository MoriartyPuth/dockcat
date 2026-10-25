import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SPRITE_SIZE = 64;      // native size of the sprite PNGs
const SIZE = 80;
const TICK_MS = 150;
const WALK_STEP = 4;
const RUN_STEP = 10;
const EDGE_MARGIN = 6;
const FOOT_INSET = 52 * SIZE / SPRITE_SIZE;
const HIDE_MARGIN = 24;     // dock counts as hidden once its top sinks this close to the screen edge

const FALL_DEPTH = SIZE;    // how far the cat drops when it falls off the edge
const FALL_STEP = 10;
const CLIMB_STEP = 8;

const ANIMATIONS = {
    'walk-right': 6,
    'walk-left': 6,
    'run-right': 5,
    'run-left': 5,
    'sit': 4,
    'play': 8,
    'sleep': 4,
    'scratch': 8,
    'stretch': 8,
    'groom': 5,
    'loaf': 8,
    'meow': 10,
    'jump-right': 5,
    'jump-left': 5,
};

// Per-animation vertical nudge so every pose rests on the dock (some sprites
// sit higher in their frame than the walk/sit poses).
const ANIM_OFFSET = {
    'sleep': 6,
    'loaf': 2,
    'run-right': 1,
    'run-left': 1,
    'scratch': -1,
    'meow': -5,
};

const TIMED_STATES = ['walk', 'run', 'idle', 'play', 'sleep', 'scratch', 'stretch', 'groom', 'loaf', 'meow'];

function randInt(min, max) {
    return min + Math.floor(Math.random() * (max - min + 1));
}

// Every dock on the stage (Dash to Dock makes one per monitor when asked to).
export function findDocks(actor, found = []) {
    const name = actor.get_name?.() ?? '';
    const cls = actor.style_class ?? '';
    if (name === 'dashtodockContainer' || cls.includes('dashtodock')) {
        found.push(actor);
        return found;
    }
    for (const child of actor.get_children?.() ?? [])
        findDocks(child, found);
    return found;
}

export const Pet = GObject.registerClass(
class Pet extends St.Icon {
    _init(basePath, dock) {
        super._init({icon_size: SIZE, reactive: false});

        this._icons = {};
        for (const [name, count] of Object.entries(ANIMATIONS)) {
            this._icons[name] = [];
            for (let i = 0; i < count; i++) {
                const file = Gio.File.new_for_path(`${basePath}/resources/${name}-${i}.png`);
                this._icons[name].push(new Gio.FileIcon({file}));
            }
        }

        this._dock = dock;
        this._x = 0;
        this._yOffset = 0;
        this._direction = 'right';
        this._frame = 0;
        this._currentAnim = 'sit';
        this._timerId = 0;
        this._enterState('idle');
    }

    start() {
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TICK_MS, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    get dock() {
        return this._dock;
    }

    // Bounds of the visible dock, or null when the dock is missing or hidden
    // (so the cat only shows while the dock is on screen).
    _dockRect() {
        if (this._dock.get_stage() === null)
            return null;

        const bounds = {left: Infinity, right: -Infinity, top: Infinity};
        this._collectIcons(this._dock, bounds);

        const monitor = Main.layoutManager.findMonitorForActor(this._dock) ??
            Main.layoutManager.primaryMonitor;
        if (!Number.isFinite(bounds.left) || bounds.right - bounds.left < this._px(SIZE + 2 * EDGE_MARGIN) ||
            bounds.top >= monitor.y + monitor.height - this._px(HIDE_MARGIN))
            return null;
        return bounds;
    }

    // Logical pixels -> stage pixels, so layout matches the HiDPI-scaled icon.
    _px(value) {
        return value * St.ThemeContext.get_for_stage(global.stage).scale_factor;
    }

    _collectIcons(actor, bounds) {
        if (actor instanceof St.Icon && actor !== this) {
            const [w] = actor.get_transformed_size();
            if (w > this._px(12) && w < this._px(128)) {
                const [x, y] = actor.get_transformed_position();
                if (Number.isFinite(x) && Number.isFinite(y)) {
                    bounds.left = Math.min(bounds.left, x);
                    bounds.right = Math.max(bounds.right, x + w);
                    bounds.top = Math.min(bounds.top, y);
                }
            }
        }
        for (const child of actor.get_children?.() ?? [])
            this._collectIcons(child, bounds);
    }

    _enterState(state) {
        this._state = state;
        this._frame = 0;
        if (state === 'walk')
            this._stateTicks = randInt(20, 55);
        else if (state === 'idle')
            this._stateTicks = randInt(8, 18);
        else if (state === 'play')
            this._stateTicks = randInt(14, 26);
        else if (state === 'sleep')
            this._stateTicks = randInt(40, 80);
        else if (state === 'run')
            this._stateTicks = randInt(14, 30);
        else if (state === 'scratch')
            this._stateTicks = randInt(16, 28);
        else if (state === 'stretch')
            this._stateTicks = randInt(14, 22);
        else if (state === 'groom')
            this._stateTicks = randInt(16, 28);
        else if (state === 'loaf')
            this._stateTicks = randInt(30, 60);
        else if (state === 'meow')
            this._stateTicks = randInt(12, 20);
    }

    _nextState() {
        if (this._state === 'idle') {
            this._enterState(this._pickActivity());
            return;
        }
        if (this._state === 'walk' || this._state === 'run')
            this._enterState(Math.random() < 0.5 ? 'idle' : this._pickActivity());
        else
            this._enterState('idle');
    }

    // Weighted pick of what the cat does next from a rest.
    _pickActivity() {
        const activities = [
            ['walk', 5], ['play', 3], ['groom', 2],
            ['scratch', 2], ['stretch', 2], ['run', 2], ['loaf', 2],
            ['meow', 2], ['sleep', 1],
        ];
        const total = activities.reduce((sum, [, weight]) => sum + weight, 0);
        let roll = Math.random() * total;
        for (const [state, weight] of activities) {
            roll -= weight;
            if (roll < 0)
                return state;
        }
        return 'walk';
    }

    _tick() {
        // Only appear while the dock is visible on the desktop.
        const rect = this._dockRect();
        if (rect === null) {
            this.hide();
            return;
        }
        this.show();

        const left = rect.left + this._px(EDGE_MARGIN);
        const right = rect.right - this._px(SIZE + EDGE_MARGIN);

        const grounded = this._state !== 'fall' && this._state !== 'climb';
        if (grounded && (this._x < left || this._x > right))
            this._x = Math.max(left, Math.min(right, this._x || left));

        this._frame++;
        switch (this._state) {
        case 'walk':    this._walk(left, right); break;
        case 'run':     this._run(left, right); break;
        case 'idle':    this._animate('sit', 4); break;
        case 'play':    this._animate('play', 2); break;
        case 'sleep':   this._animate('sleep', 3); break;
        case 'scratch': this._animate('scratch', 2); break;
        case 'stretch': this._animate('stretch', 2); break;
        case 'groom':   this._animate('groom', 3); break;
        case 'loaf':    this._animate('loaf', 4); break;
        case 'meow':    this._animate('meow', 2); break;
        case 'fall':    this._fall(); break;
        case 'climb':   this._climb(); break;
        }

        this._place(rect.top);

        if (TIMED_STATES.includes(this._state) && --this._stateTicks <= 0)
            this._nextState();
    }

    _walk(left, right) {
        const previous = this._x;
        this._x += this._px(this._direction === 'right' ? WALK_STEP : -WALK_STEP);
        const facing = this._x >= previous ? 'right' : 'left';
        if (this._x <= left || this._x >= right) {
            this._x = Math.max(left, Math.min(right, this._x));
            // Leap off facing the edge it reached; otherwise turn around.
            if (Math.random() < 0.3) {
                this._enterState('fall');
                this._fall();
                return;
            }
            this._direction = this._direction === 'right' ? 'left' : 'right';
        }
        this._animate(`walk-${facing}`, 1);
    }

    _run(left, right) {
        const previous = this._x;
        this._x += this._px(this._direction === 'right' ? RUN_STEP : -RUN_STEP);
        if (this._x <= left) {
            this._x = left;
            this._direction = 'right';
        } else if (this._x >= right) {
            this._x = right;
            this._direction = 'left';
        }
        const facing = this._x >= previous ? 'right' : 'left';
        this._animate(`run-${facing}`, 1);
    }

    _fall() {
        this._yOffset += this._px(FALL_STEP);
        this._animate(`jump-${this._direction}`, 2);
        if (this._yOffset >= this._px(FALL_DEPTH))
            this._enterState('climb');
    }

    _climb() {
        this._yOffset -= this._px(CLIMB_STEP);
        this._animate(`jump-${this._direction}`, 2);
        if (this._yOffset <= 0) {
            this._yOffset = 0;
            this._enterState('walk');
        }
    }

    _animate(name, slow) {
        const frames = this._icons[name];
        const index = Math.floor(this._frame / slow) % frames.length;
        this._currentAnim = name;
        this.set_gicon(frames[index]);
    }

    _place(dockTop) {
        const offset = (ANIM_OFFSET[this._currentAnim] ?? 0) * SIZE / SPRITE_SIZE;
        this.set_position(Math.round(this._x), Math.round(dockTop + this._px(offset - FOOT_INSET) + this._yOffset));
    }

    destroy() {
        if (this._timerId !== 0) {
            GLib.Source.remove(this._timerId);
            this._timerId = 0;
        }
        this._dock = null;
        super.destroy();
    }
});
