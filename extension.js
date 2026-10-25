import GLib from 'gi://GLib';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Pet, findDocks} from './lib/Pet.js';

const SCAN_MS = 2000;       // how often to look for docks appearing or going away

export default class DockcatExtension extends Extension {
    enable() {
        this._pets = new Map();     // dock actor -> {pet, destroyId}
        this._scan();
        this._scanId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCAN_MS, () => {
            this._scan();
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        GLib.Source.remove(this._scanId);
        this._scanId = 0;
        for (const dock of [...this._pets.keys()])
            this._removePet(dock);
        this._pets = null;
    }

    // Give every dock a cat, and drop cats whose dock has gone.
    _scan() {
        const docks = findDocks(global.stage);
        for (const dock of [...this._pets.keys()]) {
            if (!docks.includes(dock))
                this._removePet(dock);
        }
        for (const dock of docks) {
            if (this._pets.has(dock))
                continue;
            const pet = new Pet(this.path, dock);
            Main.layoutManager.addChrome(pet, {trackFullscreen: true});
            const destroyId = dock.connect('destroy', () => this._removePet(dock));
            this._pets.set(dock, {pet, destroyId});
            pet.start();
        }
    }

    _removePet(dock) {
        const entry = this._pets.get(dock);
        if (!entry)
            return;
        this._pets.delete(dock);
        dock.disconnect(entry.destroyId);
        Main.layoutManager.removeChrome(entry.pet);
        entry.pet.destroy();
    }
}
