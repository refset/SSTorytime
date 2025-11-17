# SSTorytime Emacs - Interactive Features

## New JSON-Based Browser

The Emacs interface now uses the HTTP JSON API for rich, interactive browsing with proper magit-section support.

### Visual Features

#### Color-Coded Link Types

Relationships are color-coded according to the four Semantic Spacetime types:

- **Similarity** (purple/constant) - `similar to`, `same as`, `like`, `near`
- **Leads-To** (blue/bold) - `causes`, `then`, `next`, `precedes`, `succeeds`
- **Contains** (green/type) - `contains`, `part of`, `member of`, `includes`
- **Properties** (yellow/variable) - `has property`, `means`, `note`, `remark`

#### Visual Link Distance

Connected nodes show their distance with visual connectors:
```
──> (radius 1)
────> (radius 2)
──────> (radius 3)
```

### Interactive Navigation

#### Expandable Sections

Press `TAB` to expand/collapse:
- Main search results
- Individual nodes
- Orbits (connected nodes)

#### Clickable Navigation

Press `RET` on:
- Any node text → Search for that node
- Any relationship link → Navigate to the connected node
- Results recursively expand as you explore

#### Example Session

```
Search: chinese restaurant

Time: Sun:Hr09:Qu3-Min30_35
Context: N_Autumn, S_Spring, Morning...

▼ I've never been to that restaurant                    [node]
    Chapter: notes on chinese
    Context: didn't, no, not, won't

    ──> (english has hanzi) 我没去过那家饭馆              [RET to navigate]
        [any]
      ────> (hanzi has pinyin) Wǒ méi qùguò nà jiā fànguǎn
          [didn't, no, not, won't]

▼ restaurant                                             [node]
    Chapter: notes on chinese
    Context: buildings, eating, restaurant, rooms

    ──> (english has hanzi) 饭馆
        [any]
      ────> (hanzi has pinyin) fànguǎn
          [buildings, eating, restaurant, rooms]
```

Press `RET` on "我没去过那家饭馆" → New search opens showing that node and its connections.

### Keyboard Navigation

In browse buffers:

| Key     | Action                           |
|---------|----------------------------------|
| `RET`   | Navigate to node/link at point   |
| `TAB`   | Expand/collapse section          |
| `n`     | Next section                     |
| `p`     | Previous section                 |
| `g`     | Refresh current search           |
| `s`     | New search                       |
| `c`     | Search by chapter                |
| `C`     | Search by context                |
| `?`     | Open command menu                |
| `q`     | Quit window                      |

### Recursive Exploration

You can traverse the graph recursively:

1. Search for `chinese restaurant`
2. See results with orbits (connected nodes)
3. Press `RET` on any connected node
4. That node's orbit expands
5. Continue navigating connections infinitely

This gives you a natural way to explore knowledge by following semantic relationships.

### Advantages Over Web UI

✅ **Keyboard-driven** - No mouse required
✅ **Collapsible** - Hide/show sections as needed
✅ **Recursive** - Navigate connections infinitely
✅ **Color-coded** - Link types visually distinct
✅ **Context-aware** - See chapter and context for each node
✅ **Fast** - Direct JSON API, no page reloads
✅ **Integrated** - Works with Emacs workflow

### Technical Details

#### Architecture

```
User Input → sstorytime.el → HTTP JSON API → sstorytime-browser.el
                                ↓
                            Parse JSON
                                ↓
                        magit-section tree
                                ↓
                        Interactive buffer
```

#### Data Flow

1. **Search**: Send query to `/searchN4L?name=query`
2. **Parse**: Convert JSON to elisp structures
3. **Display**: Build magit-section hierarchy
4. **Interact**: Click nodes to recursively search
5. **Navigate**: Traverse the graph infinitely

#### Structures

```elisp
sstorytime-search-result
  :query "chinese restaurant"
  :nodes (list of sstorytime-result-node)
    :text "I've never been to that restaurant"
    :chap "notes on chinese"
    :context "didn't, no, not, won't"
    :orbits (list of sstorytime-orbit-node)
      :radius 1
      :arrow "english has hanzi"
      :text "我没去过那家饭馆"
```

### Performance

- JSON API is faster than CLI parsing
- Lazy loading (only fetch what you click)
- No page state to manage
- Efficient buffer reuse

### Customization

#### Custom Link Colors

```elisp
(set-face-attribute 'sstorytime-link-similarity nil
                    :foreground "#ff00ff"
                    :slant 'italic)

(set-face-attribute 'sstorytime-link-leadsto nil
                    :foreground "#0000ff"
                    :weight 'bold)
```

#### Default Expansion

Currently, all sections start collapsed. To expand by default:

```elisp
(add-hook 'sstorytime-browse-mode-hook
          (lambda ()
            (magit-section-show-level-1-all)))
```

### Known Limitations

1. **Depth limit**: Very deep recursion might be slow
2. **Large results**: >100 nodes may take time to render
3. **No graph visualization**: Text-only (for now)
4. **No caching**: Each click re-queries server

### Future Enhancements

- [ ] Cache visited nodes
- [ ] Graphviz integration for visualization
- [ ] Inline node preview on hover
- [ ] History navigation (back/forward)
- [ ] Bookmarks for important nodes
- [ ] Export subgraph to org-mode
- [ ] Breadcrumb trail of navigation
- [ ] Minimap of overall graph structure

## Comparison: Before vs After

### Before (CLI output dump)

```
------------------------------------------------------------------
 Limiting to maximum of 10 results
------------------------------------------------------------------

  .......................................................
    Recurrent now: Sun:Hr09:Qu3-Min30_35
    Intentional  : chinese restaurant
    ...
```

Just text. No interaction. No structure.

### After (Interactive magit-section)

```
Search: chinese restaurant ▼

Time: Sun:Hr09:Qu3-Min30_35
Context: N_Autumn, S_Spring, Morning...

▼ I've never been to that restaurant
    Chapter: notes on chinese
    Context: didn't, no, not, won't

    ──> (english has hanzi) 我没去过那家饭馆 [Click to explore]
        [any]
```

Expandable. Clickable. Explorable.

## Try It

1. Load: `emacs -Q -l contrib/emacs/example-init.el`
2. Run: `M-x sstorytime-check-setup`
3. Search: `C-c k s` → type "chinese restaurant"
4. Explore: Press `TAB` and `RET` to navigate
5. Enjoy the magit-like experience!
