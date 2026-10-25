import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Pet} from './lib/Pet.js';

export default class TuxecatExtension extends Extension {
    enable() {
        this._pet = new Pet(this.path);
        Main.layoutManager.addChrome(this._pet.ball, {trackFullscreen: true});
        Main.layoutManager.addChrome(this._pet, {trackFullscreen: true});
        this._pet.start();
    }

    disable() {
        Main.layoutManager.removeChrome(this._pet);
        Main.layoutManager.removeChrome(this._pet.ball);
        this._pet.ball.destroy();
        this._pet.destroy();
        this._pet = null;
    }
}
