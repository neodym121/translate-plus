// A list picker drawn in the window's own style, used in place of <select>: the browser
// opens a native select in the system look, and a list of three hundred models with no
// way to search it. The open list floats above the window (the cards it sits in clip
// their content), gets a search box when it is long, and works from the keyboard:
// arrows, Page Up/Down, Home/End, Enter, Escape, Tab, typing to search.

const SEARCH_FROM = 10;  // options from which the open list gets a search box
const MAX_HEIGHT = 320;  // px, the open list at most
const EDGE = 8;          // px kept clear of the window edge
const GAP = 4;           // px between the field and its list

let seq = 0;
let openOne = null;      // the dropdown whose list is open

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {object} o
 * @param {HTMLButtonElement} [o.button]  a trigger already in the page; one is made when absent
 * @param {string} [o.id]  id of the trigger that is made (for <label for>)
 * @param {() => {search: string, empty: string}} o.texts  the interface strings, read on every open
 * @param {(value: string) => void} [o.onChange]  called when the user picks another option
 * Options: {value, label, detail?, group?}; consecutive options with the same group share a heading.
 */
export function createDropdown({ button, id, texts, onChange }) {
  const trigger = button ?? el('button', 'select dd');
  if (!button && id) trigger.id = id;
  trigger.classList.add('dd');
  trigger.type = 'button';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  const shown = el('span', 'dd-value');
  trigger.replaceChildren(shown);

  const listId = `dd-list-${++seq}`;
  let options = [];
  let value = '';
  let menu = null; // {root, list, search, items: [{option, node}], active, grouped}

  function paint() {
    const option = options.find((o) => o.value === value);
    shown.textContent = option ? option.label : value;
    if (!button) trigger.title = shown.textContent;
  }

  function setOptions(list, selected) {
    options = list.slice();
    // A saved choice the list no longer offers stays visible and selected.
    if (selected && !options.some((o) => o.value === selected)) options.unshift({ value: selected, label: selected });
    value = selected ?? options[0]?.value ?? '';
    paint();
    if (!menu) return;
    if (!menu.search && options.length >= SEARCH_FROM) {
      // the list grew long while it was open (it was still loading): open it again with a search box
      close(false);
      open();
      return;
    }
    render();
    place();
    highlightSelected();
  }

  function pick(next) {
    if (next !== value) {
      value = next;
      paint();
      onChange?.(next);
    }
  }

  // --------------------------------------------------------------- the list

  function render() {
    const words = (menu.search?.value ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean);
    const fragment = document.createDocumentFragment();
    menu.items = [];
    menu.grouped = false;
    let group = null;
    options.forEach((option, i) => {
      const haystack = `${option.label} ${option.detail ?? ''} ${option.value} ${option.group ?? ''}`.toLowerCase();
      if (!words.every((w) => haystack.includes(w))) return;
      if ((option.group ?? '') !== group) {
        group = option.group ?? '';
        if (group) {
          const heading = el('li', 'dd-group', group);
          heading.setAttribute('role', 'presentation');
          fragment.append(heading);
          menu.grouped = true;
        }
      }
      const node = el('li', 'dd-option');
      node.id = `${listId}-${i}`;
      node.setAttribute('role', 'option');
      node.setAttribute('aria-selected', String(option.value === value));
      node.dataset.index = String(menu.items.length);
      const text = el('span', 'dd-text');
      text.append(el('span', 'dd-label', option.label));
      if (option.detail) text.append(el('span', 'dd-detail', option.detail));
      node.append(text);
      fragment.append(node);
      menu.items.push({ option, node });
    });
    if (!menu.items.length) fragment.append(el('li', 'dd-empty', texts().empty));
    menu.list.replaceChildren(fragment);
    menu.active = -1;
  }

  /** Below the field when it fits (or has more room there), else above; never past the window. */
  function place() {
    const { root } = menu;
    const r = trigger.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    root.style.maxHeight = 'none';
    const want = Math.min(MAX_HEIGHT, root.scrollHeight);
    const below = vh - r.bottom - GAP - EDGE;
    const above = r.top - GAP - EDGE;
    const down = below >= want || below >= above;
    const width = Math.min(vw - 2 * EDGE, Math.max(r.width, 220));
    root.style.width = `${width}px`;
    root.style.left = `${Math.max(EDGE, Math.min(r.left, vw - EDGE - width))}px`;
    root.style.maxHeight = `${Math.max(120, Math.min(want, down ? below : above))}px`;
    root.style.top = down ? `${r.bottom + GAP}px` : '';
    root.style.bottom = down ? '' : `${vh - r.top + GAP}px`;
    root.classList.toggle('is-above', !down);
  }

  function reveal(node, center) {
    const { list } = menu;
    const pad = menu.grouped ? 30 : 4; // room for the sticky group heading
    const top = node.offsetTop;
    const bottom = top + node.offsetHeight;
    if (center) list.scrollTop = top - (list.clientHeight - node.offsetHeight) / 2;
    else if (top - pad < list.scrollTop) list.scrollTop = top - pad;
    else if (bottom + 4 > list.scrollTop + list.clientHeight) list.scrollTop = bottom + 4 - list.clientHeight;
  }

  function setActive(index, { scroll = true, center = false } = {}) {
    const previous = menu.items[menu.active];
    previous?.node.classList.remove('is-active');
    menu.active = index;
    const owner = menu.search ?? menu.list;
    const item = menu.items[index];
    if (!item) { owner.removeAttribute('aria-activedescendant'); return; }
    item.node.classList.add('is-active');
    owner.setAttribute('aria-activedescendant', item.node.id);
    if (scroll) reveal(item.node, center);
  }

  function highlightSelected() {
    const index = menu.items.findIndex((i) => i.option.value === value);
    setActive(index >= 0 ? index : 0, { center: true });
  }

  function move(delta) {
    const count = menu.items.length;
    if (!count) return;
    const from = menu.active < 0 ? (delta > 0 ? -1 : count) : menu.active;
    setActive(Math.max(0, Math.min(count - 1, from + delta)));
  }

  /** Without a search box, a typed letter jumps to the next option starting with it. */
  function jumpTo(letter) {
    const count = menu.items.length;
    for (let step = 1; step <= count; step++) {
      const i = (menu.active + step + count) % count;
      if (menu.items[i].option.label.toLowerCase().startsWith(letter)) { setActive(i); return; }
    }
  }

  function choose(index) {
    const item = menu.items[index];
    if (!item) return;
    close(true);
    pick(item.option.value);
  }

  function onKey(e) {
    const typing = !!menu.search;
    switch (e.key) {
      case 'ArrowDown': move(1); break;
      case 'ArrowUp': move(-1); break;
      case 'PageDown': move(8); break;
      case 'PageUp': move(-8); break;
      case 'Home': if (typing) return; setActive(0); break;
      case 'End': if (typing) return; setActive(menu.items.length - 1); break;
      case 'Enter': choose(menu.active); break;
      case 'Escape': close(true); break;
      case 'Tab': close(false); return;
      default:
        if (!typing && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) { jumpTo(e.key.toLowerCase()); break; }
        return;
    }
    e.preventDefault();
    e.stopPropagation();
  }

  // ------------------------------------------------------------ open / close

  const onOutsidePointer = (e) => {
    if (!menu.root.contains(e.target) && !trigger.contains(e.target)) close(false);
  };
  const onOutsideScroll = (e) => {
    if (!menu.root.contains(e.target)) close(false);
  };
  const onWindowChange = () => close(false);

  function open() {
    if (menu || trigger.disabled) return;
    openOne?.close(false);
    openOne = api;

    const root = el('div', 'dd-menu');
    let search = null;
    if (options.length >= SEARCH_FROM) {
      search = el('input', 'dd-search');
      search.type = 'search';
      search.placeholder = texts().search;
      search.autocomplete = 'off';
      search.spellcheck = false;
      search.setAttribute('role', 'searchbox');
      search.setAttribute('aria-controls', listId);
      search.setAttribute('aria-label', texts().search);
      search.addEventListener('input', () => {
        render();
        place();
        setActive(0, { center: false });
        menu.list.scrollTop = 0;
      });
      root.append(search);
    }
    const list = el('ul', 'dd-list');
    list.id = listId;
    list.tabIndex = -1;
    list.setAttribute('role', 'listbox');
    if (trigger.getAttribute('aria-label')) list.setAttribute('aria-label', trigger.getAttribute('aria-label'));
    root.append(list);

    // Keep the focus in the search box while an option is clicked.
    list.addEventListener('mousedown', (e) => { if (e.target.closest('.dd-option')) e.preventDefault(); });
    list.addEventListener('click', (e) => {
      const node = e.target.closest('.dd-option');
      if (node) choose(Number(node.dataset.index));
    });
    list.addEventListener('mousemove', (e) => {
      const node = e.target.closest('.dd-option');
      if (node && Number(node.dataset.index) !== menu.active) setActive(Number(node.dataset.index), { scroll: false });
    });
    root.addEventListener('keydown', onKey);

    document.body.append(root);
    menu = { root, list, search, items: [], active: -1, grouped: false };
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', listId);
    render();
    place();
    highlightSelected();
    (search ?? list).focus({ preventScroll: true });

    document.addEventListener('pointerdown', onOutsidePointer, true);
    document.addEventListener('scroll', onOutsideScroll, true);
    window.addEventListener('resize', onWindowChange);
    window.addEventListener('blur', onWindowChange);
  }

  function close(focusTrigger) {
    if (!menu) return;
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    document.removeEventListener('scroll', onOutsideScroll, true);
    window.removeEventListener('resize', onWindowChange);
    window.removeEventListener('blur', onWindowChange);
    menu.root.remove();
    menu = null;
    if (openOne === api) openOne = null;
    trigger.setAttribute('aria-expanded', 'false');
    trigger.removeAttribute('aria-controls');
    if (focusTrigger) trigger.focus({ preventScroll: true });
  }

  trigger.addEventListener('click', () => (menu ? close(true) : open()));
  trigger.addEventListener('keydown', (e) => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
      e.preventDefault();
      open();
    }
  });

  const api = {
    node: trigger,
    setOptions,
    close,
    get value() { return value; },
    set disabled(on) {
      trigger.disabled = on;
      if (on) close(false);
    },
  };
  return api;
}
