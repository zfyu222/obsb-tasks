// @ts-nocheck — pinned upstream implementation; task adapter is strictly checked.
// Extracted from zfyu222/obsidian-enhancing-mindmap, 0.2.6-beta.41 (7c39cf6).
// Copyright (c) 2021 Mark. MIT; see LICENSE.md in this directory.
import type { LayoutNode as Node, LayoutHost as MindMap } from './types'

const randomColor = () => '#6580b8';

export default class Layout {
    layoutName='mindmap';
    direct:string='';
    root:Node;
    mind?:MindMap;
    levelDis:number = 40;
    nodeDis:number = 8;
    firstLevelDis:number = 80;
    firstNodeDis:number = 20;
    svgDom?:any;
    isCache:boolean = true;
    lefts:Node[]=[];
    rights:Node[]=[];
    colors:string[]=[];
    lineWidth=2;
    constructor(node:Node,direct?:string,colors?:string[]){
       this.root = node||null;
       this.mind = node?.mindmap||null;
       this.direct = direct||'mindmap';
       this.colors=colors||[];

       if (!this.svgDom) this.svgDom = this.mind.edgeGroup.group();

       this.layout();
    }



    setDirect() {
        var me = this;
        var len = this.root.children.length;
        var root = this.root;
        this.rights = [];
        this.lefts= [];
        if (this.direct == 'right') {
            this.rights = root.children;

            this.rights.forEach(r => {
                this._setDirect(r, 'right')

            })

        } else if (this.direct == 'left') {
            this.lefts = root.children;
            this.lefts.forEach(r => {
                this._setDirect(r, 'left')
            });

        } else if (this.direct == 'clockwise') {
            root.children.forEach(function (child, i) {
                if (i < len / 2) {
                    me.rights.push(child);
                    me._setDirect(child, 'right');
                } else {
                    me.lefts.push(child);
                    me._setDirect(child, 'left');
                }
            });
            me.lefts.reverse();
        }

        else {

            root.children.forEach(function (child, i) {
                if (i < len / 2) {
                    me.rights.push(child);
                    me._setDirect(child, 'right');
                } else {
                    me.lefts.push(child);
                    me._setDirect(child, 'left');
                }
            });
        }
        this.mind?.summaries?.pinSides(root.children, this.direct);
        root.children.forEach(child => this._setDirect(child, child.direct));
        this.rights = root.children.filter(n => n.direct === 'right');
        this.lefts = root.children.filter(n => n.direct === 'left');
        if (this.direct === 'clockwise') this.lefts.reverse();
    }

    _setDirect(n:Node, direct:string) {
        const pending = [n];
        while (pending.length) {
            const item = pending.pop()!;
            const oldSecond = item.containEl.classList.contains('mm-node-second');
            item.stroke = ''; item.direct = direct;
            item.containEl.classList.remove('mm-node-left', 'mm-node-right', 'mm-node-second', 'mm-node-leaf', 'mm-node-collapse');
            item.containEl.classList.add('mm-node', 'mm-node-' + direct);
            if (item.isLeaf()) item.containEl.classList.add('mm-node-leaf');
            if (item.getLevel() === 1) { item.containEl.classList.add('mm-node-second'); item.refreshBox(); }
            if (oldSecond) item.refreshBox();
            if (!item.isExpand) item.containEl.classList.add('mm-node-collapse');
            for (let i = item.children.length - 1; i >= 0; i--) pending.push(item.children[i]);
        }
    }

    layout(node?:Node,direct?:string){
        if(node) this.root = node;
        if(direct) this.direct = direct;
        this.setDirect();

        if(this.direct == 'right'){
           this.layoutRight();
        }else if(this.direct == 'left'){
           this.layoutLeft();
        }else{
           this.layoutMindMap()
        }

        this._dolayout();

        // balance layout
        this._doRefresh();

        if (this.mind?.grafts?.items.length) this.reserveGraftSpace(this.root);

        this.createLink();
    }

    // Repeated subtrees can have different rendered heights at different depths.
    // Pack complete visible branch bounds, then center each group on its parent.
    reserveGraftSpace(node: Node) {
        if (!node.isExpand || !node.isShow()) return;
        node.children.forEach(child => this.reserveGraftSpace(child));
        for (const side of ['left', 'right']) {
            const children = node.children.filter(child => child.isShow() && child.direct === side)
                .sort((a, b) => a.getBox().y - b.getBox().y);
            if (!children.length) continue;
            const gap = node === this.root ? this.firstNodeDis : this.nodeDis;
            let bottom = -Infinity;
            children.forEach(child => {
                const bounds = this.mind.getBoundingRect(child.getShowNodeList());
                const dy = Math.max(0, bottom + gap - bounds.y);
                if (dy) this.moveNode(child, 0, dy);
                bottom = bounds.bottom + dy;
            });
            const visible: Node[] = [];
            children.forEach(child => visible.push(...child.getShowNodeList()));
            const bounds = this.mind.getBoundingRect(visible), box = node.getBox();
            const dy = box.y + box.height / 2 - (bounds.y + bounds.height / 2);
            children.forEach(child => this.moveNode(child, 0, dy));
        }
        node.boundingRect = null;
    }

    layoutMindMap(){
         this.layoutRight();
         this.layoutLeft();
    }

    layoutRight(arr?:Node[],parent?:Node) {
        const pending = [{ nodes: arr || this.rights, parent: parent || this.root }];
        while (pending.length) {
            const { nodes, parent: p } = pending.pop()!;
            if (!nodes.length) continue;
            const pos = p.getPosition(), box = p.getBox(), level = p.getLevel();
            const dis = level === 0 ? this.firstLevelDis : this.levelDis;
            const gap = level === 0 ? this.firstNodeDis : this.nodeDis;
            const { disHeight, height } = this._getNodesHeight(nodes), h = height / nodes.length;
            const x = Math.trunc(pos.x + box.width + dis);
            let y = Math.trunc(pos.y + (level < 2 ? box.height / 2 : box.height) - disHeight / 2 - (level === 0 ? 0 : h / 2) - (level === 1 ? this.lineWidth / 2 : 0));
            for (const child of nodes) { child.setPosition(x, y); y += Math.trunc(child.getBox().height + gap); }
            for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].isExpand) pending.push({ nodes: nodes[i].children, parent: nodes[i] });
        }
    }

    layoutLeft(arr?:Node[],parent?:Node) {
        const pending = [{ nodes: arr || this.lefts, parent: parent || this.root }];
        while (pending.length) {
            const { nodes, parent: p } = pending.pop()!;
            if (!nodes.length) continue;
            const pos = p.getPosition(), box = p.getBox(), level = p.getLevel();
            const dis = level === 0 ? this.firstLevelDis : this.levelDis;
            const gap = level === 0 ? this.firstNodeDis : this.nodeDis;
            const { disHeight, height } = this._getNodesHeight(nodes), h = height / nodes.length;
            const x = Math.trunc(pos.x - dis);
            let y = Math.trunc(pos.y + (level < 2 ? box.height / 2 : box.height) - disHeight / 2 - (level === 0 ? 0 : h / 2) - (level === 1 ? this.lineWidth / 2 : 0));
            for (const child of nodes) { child.setPosition(Math.trunc(x - child.getBox().width), Math.trunc(y)); y += child.getBox().height + gap; }
            for (let i = nodes.length - 1; i >= 0; i--) if (nodes[i].isExpand) pending.push({ nodes: nodes[i].children, parent: nodes[i] });
        }
    }

    _getNodesHeight(nodes:Node[]){
        if (nodes[0] && nodes[0].getLevel() == 1) {
            var dis = this.firstNodeDis;
        } else {
            var dis = this.nodeDis;
        }
        var h = 0;
        var h1 = 0;
        if(nodes.length==1){
            var h =nodes[0].getBox().height;
            return {
                disHeight:h,
                height:h
            };
        }
        nodes.forEach((item, index) => {
            var height = item.getBox().height;
            h += height;
            h1 += height;
            if (index != nodes.length - 1) {
                h += dis;
            }
        });
        return {
            disHeight:h,
            height:h1
        };
    }

    _doRefresh() {
        var root = this.root;
        var rootPos = root.getPosition();
        var rootBox = root.getBox();
        var center = rootPos.y + rootBox.height / 2;
        var rights = this.rights;
        var lefts = this.lefts;
        if (rights.length >= 2) {
            var firstNode = rights[0];
            var lastNode = rights[rights.length - 1];

            var firstPos = firstNode.getPosition();
            var lastPos = lastNode.getPosition();
            var lastBox = lastNode.getBox();
            var dis1 = lastPos.y + lastBox.height - center;
            var dis2 = center - firstPos.y;
            if (Math.abs(dis1) != Math.abs(dis2)) {
                var dy = Math.abs(Math.abs(dis1) - Math.abs(dis2)) / 2 +'';
                if (Math.abs(dis1) > Math.abs(dis2)) {
                    rights.forEach(c => {
                        this.moveNode(c, 0, -parseInt(dy))
                    });
                } else {
                    rights.forEach(c => {
                        this.moveNode(c, 0, parseInt(dy))
                    });
                }
            }
        }

        if (lefts.length >= 2) {
            var firstNode = lefts[0];
            var lastNode = lefts[lefts.length - 1];

            var firstPos = firstNode.getPosition();
            var lastPos = lastNode.getPosition();
            var lastBox = lastNode.getBox();
            var dis1 = lastPos.y + lastBox.height - center;
            var dis2 = center - firstPos.y;
            if (Math.abs(dis1) != Math.abs(dis2)) {
                var dy = Math.abs(Math.abs(dis1) - Math.abs(dis2)) / 2 +'';
                if (Math.abs(dis1) > Math.abs(dis2)) {
                    lefts.forEach(c => {
                        this.moveNode(c, 0, -parseInt(dy))
                    });
                } else {
                    lefts.forEach(c => {
                        this.moveNode(c, 0, parseInt(dy))
                    });
                }
            }
        }
    }

    moveNode(node:Node, dx:number, dy:number) {
        if (!dx && !dy) return;
        const pending = [node];
        while (pending.length) {
            const current = pending.pop()!; current.move(dx, dy);
            for (const child of current.children) pending.push(child);
        }
    }

    //fix 0.5 line width bug
    linePoint(arr:any[], lineWidth:number) {
        let num = 0;
        var func:Function;
        if (lineWidth % 2 == 1) {
            num = 0.5
            func = parseInt;
        }else{
            func = Math.ceil;
        }
        var p = arr.map((item:any) => {
            return [func(item[0]) + num, func(item[1]) + num]
        });
        return p;
    }

    _dolayout(){
        var me = this;
        var mind = this.mind;

        mind.traverseDF((n:Node) => {
            if (n == me.root || !n.children.length || !n.parent || n.parent.children.length < 2) return;

            if (!n.isExpand) {
                return
            }

            var box = n.getCBox();

            if (me.isCache && n.boundingRect) {
                var cbox = n.boundingRect;
            } else {
                var list = n.getShowNodeList();
                if (list.length) {
                     cbox = mind.getBoundingRect(list);
                }
            }

            if(!cbox) return;

            if (n.boundingRect && me.isCache) {
                var topDy = cbox.topDy,
                    downDy = cbox.downDy;
            } else {
                 topDy = Math.abs(cbox.y - box.y);
                 downDy = Math.abs(cbox.y + cbox.height - box.y - box.height);
                 cbox.topDy = topDy;
                 cbox.downDy = downDy;
                 n.boundingRect = cbox;
            }

            me._adjustNode(n, 0, topDy, downDy);
        });
    }



    _adjustNode(node:Node, dx:number, dy1:number, dy2:number) {
        if (!node || (!dx && !dy1 && !dy2)) return;
        var direct = node.direct;
        if (node && node != this.root) {
            var sibs = node.getSiblings();
            var pos = node.getPosition();
            sibs.forEach((sib) => {
                if (sib.direct == direct) {
                    var sibPos = sib.getPosition();
                    if (sibPos.y > pos.y) {
                        this.moveNode(sib, dx, dy2);
                    } else {
                        this.moveNode(sib, dx, -dy1);
                    }
                }
            })

        }
    }

    refresh(node?:Node,direct?:string){
        this.layout(node,direct);
    }

    createLink(){
        var me = this;
        this.svgDom && this.svgDom.clear();
        if (this.root.getChildren().length == 0) {
            return;
        }

		var dis = this.levelDis;
		var root = this.root;
        var lineWidth = this.lineWidth;

		var rootLevel = this.root.getLevel();


		function createLine(rootNode:Node) {
            const pending = [rootNode];
            while (pending.length) {
            const node = pending.pop()!;
			if (!node.isExpand) {
				continue;
			}
			var children = node.getChildren();
			var pos = node.getPosition();
			var box = node.getBox();
			box.height = box.height + lineWidth;

			var level = node.getLevel();
			children.length && children.forEach(function (child) {
				var direct = child.direct;
				var childPos = child.getPosition();
				var childBox = {
					...child.getBox()
				};

				childBox.height = childBox.height + lineWidth;

				let _stroke =  node.stroke?node.stroke:(child.stroke?child.stroke:randomColor());

                if(!child.stroke){
                    child.stroke = _stroke;
                }

                child._barDom.style.backgroundColor = _stroke;
                child._barDom.style.borderColor = _stroke;

				if (level == rootLevel) {
					var from = {
						x: pos.x + box.width / 2,
						y: pos.y + box.height / 2
					};
				} else if (level == 1 + rootLevel) {
					if (direct == 'right') {
						 from = {
							x: pos.x + box.width,
							y: pos.y + box.height / 2
						};
					} else {
						 from = {
							x: pos.x,
							y: pos.y + box.height / 2
						}
					}

				} else {
					if (direct == 'right') {
						 from = {
							x: pos.x + box.width,
							y: pos.y + box.height
						};
					} else {
						 from = {
							x: pos.x,
							y: pos.y + box.height
						};
					}
				}

				if (level == rootLevel) {
					if (direct == 'right') {
						var to = {
							x: childPos.x,
							y: childBox.height / 2 + childPos.y
						};
					} else {
						 to = {
							x: childPos.x + childBox.width,
							y: childBox.height / 2 + childPos.y
						};
					}
				} else {
					if (direct == 'right') {
						 to = {
							x: childPos.x,
							y: childBox.height + childPos.y
						};
					} else {
						 to = {
							x: childPos.x + childBox.width,
							y: childBox.height + childPos.y
						};
					}
				}


				if (lineWidth % 2 == 1) {

					var x1 = parseInt(from.x+'') - 0.5;
					var x2 = parseInt(to.x+'') - 0.5;

					var y1 = parseInt(from.y+'') - 0.5;
					var y2 = parseInt(to.y+'') - 0.5;
				} else {
					var x1 = parseInt(from.x+'');
					var y1 = parseInt(from.y+'');
					var x2 = parseInt(to.x+'');
					var y2 = parseInt(to.y+'');
				}


				if (level == rootLevel) {
					var line1 = me.svgDom.path().stroke({
						color: _stroke,
						width: lineWidth + 1,
						linecap: 'round',
						linejoin: 'round'
					}).fill('none');
				} else {
					var line1 = me.svgDom.path().stroke({
						color: _stroke,
						width: lineWidth,
						linecap: 'round',
						linejoin: 'round'
					}).fill('none');
				}

				if (lineWidth % 2 == 1) {
					var x11 = parseInt(childPos.x+'') - 0.5;
					var x22 = parseInt(childPos.x + childBox.width+'') - 0.5;

					var y11 = y2;
					var y22 = y2;

				} else {
					var x11 = parseInt(childPos.x+'')
					var y11 = parseInt(childBox.height + childPos.y+'')
					var x22 = parseInt(childPos.x + childBox.width+'')
					var y22 = parseInt(childBox.height + childPos.y+'')
				}

				if (level == rootLevel) {

					var cpx1 = parseInt(from.x+'') + (to.x - from.x) / 9;
					var cpy1 = parseInt(from.y+'') + (to.y - from.y) / 9 * 8;
					var cpx2 = parseInt(from.x + (to.x - from.x) / 9 * 8+'');
					var cpy2 = parseInt(to.y+'');

					var pathStr = `M${x1} ${y1}  C ${cpx1} ${cpy1}, ${cpx2} ${cpy2}, ${x2} ${y2}`;
					line1.plot(pathStr);

				} else {

					me.svgDom.line(x11, y11, x22, y22).stroke({
						color: _stroke,
						width: lineWidth,
						linecap: 'miter',
						linejoin: 'miter'
					}).fill('none');

					//var c = parseInt((to.y - from.y) / 6+'');
					 var cpx11 = {
						x: from.x + dis / 2,
						y: from.y
					}
					 var cpx12 = {
						x: from.x + dis / 2,
						y: to.y
					}
					if (direct == 'left') {
						cpx11.x = from.x - dis / 2;
						cpx12.x = from.x - dis / 2;
					}

					cpx11.x = parseInt(cpx11.x+'');
					cpx11.y = parseInt(cpx11.y+'');
					cpx12.x = parseInt(cpx12.x+'');
					cpx12.y = parseInt(cpx12.y+'');

					var path = `M${x1} ${y1}  C ${cpx11.x} ${cpx11.y}, ${cpx12.x} ${cpx12.y}, ${x2} ${y2}`;

					line1.plot(path);

				}

				pending.push(child);
			});
		}
            }


        //Set Node link Color
        this.root.children.forEach((c:Node,i:number)=>{
            c.stroke=this.colors[i]||randomColor();
        });

		createLine(root);
    }



}
