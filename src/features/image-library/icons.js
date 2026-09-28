// Line icons from the userscript (feather-style paths), built with ctx.dom.h / core h().

import { h } from '../../core/dom.js';

const PATHS = {
  image: [['rect', { x: '3', y: '3', width: '18', height: '18', rx: '2', ry: '2' }], ['circle', { cx: '8.5', cy: '8.5', r: '1.5' }], ['polyline', { points: '21 15 16 10 5 21' }]],
  folder: [['path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }]],
  folderPlus: [['path', { d: 'M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z' }], ['line', { x1: '12', y1: '11', x2: '12', y2: '17' }], ['line', { x1: '9', y1: '14', x2: '15', y2: '14' }]],
  upload: [['path', { d: 'M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4' }], ['polyline', { points: '17 8 12 3 7 8' }], ['line', { x1: '12', y1: '3', x2: '12', y2: '15' }]],
  search: [['circle', { cx: '11', cy: '11', r: '8' }], ['line', { x1: '21', y1: '21', x2: '16.65', y2: '16.65' }]],
  chevronLeft: [['polyline', { points: '15 18 9 12 15 6' }]],
  chevronRight: [['polyline', { points: '9 18 15 12 9 6' }]],
  empty: [['path', { d: 'M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z' }], ['polyline', { points: '13 2 13 9 20 9' }]],
};

export function svgIcon(name) {
  return h('svg', {
    viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': '2',
    'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', class: 'il-ico',
  }, (PATHS[name] || PATHS.image).map(([tag, attrs]) => h(tag, attrs)));
}
