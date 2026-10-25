import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const SPRITE_SIZE = 64;      // native size of the sprite PNGs
const SIZE = 96;
const SCALE = SIZE / SPRITE_SIZE;
const TICK_MS = 50;         // physics tick; jumps move every tick for a smooth arc
const STEP_TICKS = 3;       // ...and everything else steps once every 3 ticks
const WALK_STEP = 4;
const RUN_STEP = 10;
const EDGE_MARGIN = 6;
const FOOT_INSET = 52;      // sprite rows from the top of the frame down to the dock line
const FEET_Y = 48;          // sprite row the paws rest on
const BODY_LEFT = 12;       // sprite columns the body spans when side-on
const BODY_RIGHT = 52;
const HIDE_MARGIN = 24;     // dock counts as hidden once its top sinks this close to the screen edge

const FALL_CHANCE = 0.3;    // chance of leaping off when a walk reaches the end of the dock
const GRAVITY = 3;          // px per tick², used for both leaps
const FALL_TICKS = 10;      // flight time down off the dock
const CLIMB_TICKS = 12;     // flight time back up onto it
const CROUCH_TICKS = 2;     // crouch before take-off
const LAND_TICKS = 4;       // crouch after landing, then a beat standing
const MIN_DROP = 16;        // don't bother leaping off if the floor is barely below the dock

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

// Vertical nudge (sprite px, per animation or per frame) so every pose rests
// its paws on row FEET_Y like the walk/sit poses do.
const ANIM_OFFSET = {
    'sleep': [7, 7, 4, 4],
    'loaf': 2,
    'meow': -5,
};

// These sheets only face right; they get mirrored when the cat faces left.
const RIGHT_ONLY = ['groom', 'stretch'];

// 'sit' and 'sleep' are sets of still poses, not animations.
const SIT_FRONT = 0;
const SIT_BACK = 1;
const SIT_FACING = {left: 2, right: 3};
const SLEEP_CURLED = {left: 0, right: 1};
const SLEEP_STRETCHED = {left: 3, right: 2};

// Frames of the run sheet: a 3-frame gallop, then a braking and a turning pose.
const RUN_GALLOP = 3;
const RUN_BRAKE = 3;
const RUN_TURN = 4;

// Frames of the jump sheet.
const JUMP_STAND = 4;
const JUMP_AIR = 2;
const JUMP_CROUCH = 3;

const TIMED_STATES = ['walk', 'run', 'idle', 'play', 'sleep', 'scratch', 'stretch', 'groom', 'loaf', 'meow', 'floor'];

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
        this.set_pivot_point(0.5, 0.5);

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
        this._subTick = 0;
        this._currentAnim = 'sit';
        this._currentFrame = 0;
        this._jump = null;
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

        const monitor = Main.layoutManager.findMonitorForActor(this._dock) ??
            Main.layoutManager.primaryMonitor;
        const bounds = {left: Infinity, right: -Infinity, top: Infinity, monitor};
        this._collectIcons(this._dock, bounds);

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
        else if (state === 'floor')
            this._stateTicks = randInt(10, 24);

        if (state === 'idle') {
            const roll = Math.random();
            this._pose = roll < 0.6 ? SIT_FACING[this._direction]
                : roll < 0.9 ? SIT_FRONT : SIT_BACK;
        } else if (state === 'sleep') {
            this._pose = Math.random() < 0.5
                ? SLEEP_CURLED[this._direction] : SLEEP_STRETCHED[this._direction];
        }
    }

    _nextState(rect) {
        if (this._state === 'floor') {
            this._leapOn(rect);
            return;
        }
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

        if (this._state === 'jump') {
            this._stepJump();
        } else if (++this._subTick >= STEP_TICKS) {
            this._subTick = 0;
            this._step(rect);
        }
        this._place(rect.top);
    }

    _step(rect) {
        const left = rect.left + this._px(EDGE_MARGIN);
        const right = rect.right - this._px(SIZE + EDGE_MARGIN);

        if (this._state !== 'floor' && (this._x < left || this._x > right))
            this._x = Math.max(left, Math.min(right, this._x || left));

        this._frame++;
        switch (this._state) {
        case 'walk':    this._walk(rect, left, right); break;
        case 'run':     this._run(left, right); break;
        case 'idle':    this._show('sit', this._pose); break;
        case 'play':    this._animate('play', 2); break;
        case 'sleep':   this._show('sleep', this._pose); break;
        case 'scratch': this._animate('scratch', 2); break;
        case 'stretch': this._animate('stretch', 2); break;
        case 'groom':   this._animate('groom', 3); break;
        case 'loaf':    this._animate('loaf', 4); break;
        case 'meow':    this._animate('meow', 2); break;
        case 'floor':   this._show('sit', SIT_FACING[this._direction]); break;
        }

        if (TIMED_STATES.includes(this._state) && --this._stateTicks <= 0)
            this._nextState(rect);
    }

    _walk(rect, left, right) {
        const facing = this._direction;
        this._x += this._px(facing === 'right' ? WALK_STEP : -WALK_STEP);
        if (this._x <= left || this._x >= right) {
            this._x = Math.max(left, Math.min(right, this._x));
            if (Math.random() < FALL_CHANCE && this._leapOff(rect))
                return;
            this._direction = facing === 'right' ? 'left' : 'right';
        }
        this._animate(`walk-${facing}`, 1);
    }

    _run(left, right) {
        const facing = this._direction;
        const sheet = `run-${facing}`;
        if (this._stateTicks <= 1) {
            // Skid to a stop on the last step.
            this._show(sheet, RUN_BRAKE);
            return;
        }
        this._x += this._px(facing === 'right' ? RUN_STEP : -RUN_STEP);
        if (this._x <= left || this._x >= right) {
            this._x = Math.max(left, Math.min(right, this._x));
            this._direction = facing === 'right' ? 'left' : 'right';
            this._show(sheet, RUN_TURN);
            return;
        }
        this._show(sheet, this._frame % RUN_GALLOP);
    }

    // Offset from the resting height down to where the paws touch the
    // bottom of the screen.
    _floorOffset(rect) {
        const {monitor} = rect;
        const restingFeet = rect.top + this._px((FEET_Y - FOOT_INSET) * SCALE);
        return monitor.y + monitor.height - restingFeet;
    }

    // Leap off the end of the dock it is facing, down beside it. Returns
    // false when there is no room to land (dock reaches the screen edge).
    _leapOff(rect) {
        const {monitor} = rect;
        const drop = this._floorOffset(rect);
        const x = this._direction === 'right'
            ? rect.right + this._px(4 - BODY_LEFT * SCALE)
            : rect.left - this._px(4 + BODY_RIGHT * SCALE);
        if (drop < this._px(MIN_DROP) ||
            x + this._px(BODY_LEFT * SCALE) < monitor.x ||
            x + this._px(BODY_RIGHT * SCALE) > monitor.x + monitor.width)
            return false;

        this._startJump(x, drop, FALL_TICKS, () => {
            // Sit down facing back towards the dock before jumping back up.
            this._direction = this._direction === 'right' ? 'left' : 'right';
            this._enterState('floor');
        });
        return true;
    }

    // Jump back up onto the end of the dock it fell off.
    _leapOn(rect) {
        const x = this._direction === 'left'
            ? rect.right - this._px(SIZE + EDGE_MARGIN)
            : rect.left + this._px(EDGE_MARGIN);
        this._startJump(x, 0, CLIMB_TICKS, () => this._enterState('walk'));
    }

    // A ballistic leap to (x, yOffset) that lands after exactly `ticks`
    // physics ticks, with a crouch before and after.
    _startJump(x, yOffset, ticks, then) {
        const g = this._px(GRAVITY);
        this._jump = {
            x, yOffset, then, g,
            vx: (x - this._x) / ticks,
            vy: (yOffset - this._yOffset - g * ticks * (ticks + 1) / 2) / ticks,
            air: ticks,
            crouch: CROUCH_TICKS,
            land: LAND_TICKS * STEP_TICKS,
        };
        this._state = 'jump';
    }

    _stepJump() {
        const jump = this._jump;
        const sheet = `jump-${this._direction}`;
        if (jump.crouch > 0) {
            jump.crouch--;
            this._show(sheet, JUMP_CROUCH);
        } else if (jump.air > 0) {
            jump.vy += jump.g;
            this._x += jump.vx;
            this._yOffset += jump.vy;
            if (--jump.air === 0) {
                this._x = jump.x;
                this._yOffset = jump.yOffset;
            }
            this._show(sheet, JUMP_AIR);
        } else if (jump.land > 0) {
            jump.land--;
            this._show(sheet, jump.land >= LAND_TICKS ? JUMP_CROUCH : JUMP_STAND);
        } else {
            this._jump = null;
            this._subTick = 0;
            jump.then();
        }
    }

    _animate(name, slow) {
        this._show(name, Math.floor(this._frame / slow) % this._icons[name].length);
    }

    _show(name, index) {
        this._currentAnim = name;
        this._currentFrame = index;
        this.set_gicon(this._icons[name][index]);
        this.scale_x = RIGHT_ONLY.includes(name) && this._direction === 'left' ? -1 : 1;
    }

    _place(dockTop) {
        let offset = ANIM_OFFSET[this._currentAnim] ?? 0;
        if (Array.isArray(offset))
            offset = offset[this._currentFrame];
        this.set_position(Math.round(this._x),
            Math.round(dockTop + this._px((offset - FOOT_INSET) * SCALE) + this._yOffset));
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
