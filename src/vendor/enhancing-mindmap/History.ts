// @ts-nocheck — pinned upstream implementation; task adapter is strictly checked.
// Extracted from zfyu222/obsidian-enhancing-mindmap, 0.2.6-beta.41 (7c39cf6).
// Copyright (c) 2021 Mark. MIT; see LICENSE.md in this directory.
import type { HistoryCommand as Command } from "./types";
class History {

    limit:number = 50;
    undos:Command[] = [];
    redos:Command[] = [];
    saveCommand:Command = null;

    constructor(limit?:number) {
        this.limit = limit || 50;
    }

    decorate?: (command: any) => any;

    execute(command:Command) {
        if (this.decorate) command = this.decorate(command);
        if (command.execute()){
            this.clearRedo();
            var length = this.undos.length;
            if (length >= this.limit) {
                this.undos.shift();
            }
            this.undos.push(command);
            this.change(command)
        }
    }

    undo() {
        if(this.canUndo()) {
            var command = this.undos.pop();
            this.redos.push(command);
            command.undo();
            this.change(command);
        }
    }

    canUndo() {
        return !!this.undos.length
    }

    redo() {
        if (this.canRedo()) {
            var command = this.redos.pop()
            this.undos.push(command);
            command.redo();
            this.change(command)
        }
    }

    canRedo() {
        return !!this.redos.length
    }

    save() {
        this.saveCommand = this.undos[this.undos.length - 1];
    }

    dirty() {
        return this.saveCommand != this.undos[this.undos.length - 1];
    }

    clearRedo() {
        this.redos = [];
    }

    clear() {
        this.undos = [];
        this.redos = [];
        this.saveCommand = null;
        this.change();
    }

    change(cmd?:any) {

    }
}
export default History;
