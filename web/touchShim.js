// The desktop port handles mouse events only. Browsers turn a tap into mouse
// events, but not a drag, so on touch screens nothing could be dragged.
// This translates single-finger touches into mousedown/mousemove/mouseup/click.

const TAP_SLOP = 10; // px a finger may wiggle and still count as a tap

function isEditable (el) {
    return el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' ||
        el.isContentEditable);
}

function fire (type, touch, target, detail) {
    const ev = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        view: window,
        detail: detail || 1,
        screenX: touch.screenX,
        screenY: touch.screenY,
        clientX: touch.clientX,
        clientY: touch.clientY,
        button: 0,
        buttons: type === 'mouseup' || type === 'click' ? 0 : 1
    });
    target.dispatchEvent(ev);
}

export function installTouchShim () {
    if (!('ontouchstart' in window) && !(navigator.maxTouchPoints > 0)) {
        return;
    }
    let active = null; // {id, target, startX, startY, moved}

    document.addEventListener('touchstart', (e) => {
        if (active || e.touches.length > 1) {
            return; // ignore extra fingers
        }
        const t = e.changedTouches[0];
        const target = t.target;
        if (isEditable(target)) {
            return; // let the browser focus fields and show the keyboard
        }
        e.preventDefault(); // no scrolling, zooming or duplicate mouse events
        active = {id: t.identifier, target, startX: t.clientX, startY: t.clientY, moved: false};
        fire('mousedown', t, target);
    }, {passive: false, capture: true});

    document.addEventListener('touchmove', (e) => {
        if (!active) {
            return;
        }
        const t = Array.from(e.changedTouches).find((x) => x.identifier === active.id);
        if (!t) {
            return;
        }
        e.preventDefault();
        if (Math.abs(t.clientX - active.startX) > TAP_SLOP || Math.abs(t.clientY - active.startY) > TAP_SLOP) {
            active.moved = true;
        }
        const over = document.elementFromPoint(t.clientX, t.clientY) || active.target;
        fire('mousemove', t, over);
    }, {passive: false, capture: true});

    const end = (e) => {
        if (!active) {
            return;
        }
        const t = Array.from(e.changedTouches).find((x) => x.identifier === active.id);
        if (!t) {
            return;
        }
        e.preventDefault();
        const over = document.elementFromPoint(t.clientX, t.clientY) || active.target;
        fire('mouseup', t, over);
        if (!active.moved && e.type === 'touchend') {
            fire('click', t, active.target);
        }
        active = null;
    };
    document.addEventListener('touchend', end, {passive: false, capture: true});
    document.addEventListener('touchcancel', end, {passive: false, capture: true});

    // stop the browser from panning/zooming the page during gestures
    const style = document.createElement('style');
    style.textContent = 'html, body { touch-action: none; overscroll-behavior: none; }';
    document.head.appendChild(style);
}
