/**
 * L5.9: the Studio's design system (docs/reference/studio-ui.md, DESIGN §4k) — built in-house on React and the
 * platform (native controls, `<dialog>`, `popover`): no component library. Screens use these (a source lint keeps new
 * screens on the kit and lets the legacy count only go down); `kit.css` reads the `--ui-*` tokens of tokens.ts.
 */
export { Button, IconButton, Kbd, LinkButton } from './Button.js';
export type { ButtonProps, ButtonSize, ButtonVariant, IconButtonProps } from './Button.js';
export { Icon, ICON_NAMES } from './Icon.js';
export type { IconName } from './Icon.js';
export { Segmented, SegmentedLinks } from './Segmented.js';
export type { SegmentLink, SegmentOption } from './Segmented.js';
export { Switch } from './Switch.js';
export { FieldRow, NumberField, RadioGroup, Select, TextArea, TextField, unsavedFor } from './fields.js';
export type { FieldLayout, RadioOption, SelectOption } from './fields.js';
export { MARK_STATES, Progress, Shape, StatusMark, Timecode, formatTimecode, spokenTimecode } from './marks.js';
export type { MarkState } from './marks.js';
export { Blocker, Callout, Checklist, ChecklistItem, Disclosure, EmptyState, Facts, InspectorSection, SourceList, StatusBar, TerminalCommands, Toolbar } from './panes.js';
export type { BlockerFix, SourceGroup, SourceItem } from './panes.js';
export { FrameCard, PosterCard, PosterGrid, gridColumns } from './cards.js';
export type { PosterItem } from './cards.js';
export { FrameGrid, FrameOption, RowCard, RowList, RowListItem, dropSide, slotFromPointer } from './frames.js';
export type { FrameDrag, FrameRect } from './frames.js';
export { ChoiceChips } from './ChoiceChips.js';
export type { ChoiceChip } from './ChoiceChips.js';
export { Playhead, Scrubber, TARGET_PX, Track, TrackItem, spaceTicks, spanStyle, tickStyle } from './tracks.js';
export type { TrackItemProps, TrackItemVariant } from './tracks.js';
export { ContactSheet, Tag } from './ContactSheet.js';
export { DiffTable, RegionOverlay } from './DiffTable.js';
export type { DiffPiece, DiffRow } from './DiffTable.js';
export type { ContactSheetItem } from './ContactSheet.js';
export { Menu } from './Menu.js';
export type { MenuEntry, MenuItemDef } from './Menu.js';
export { Sheet, defaultAction } from './Sheet.js';
export type { SheetAction } from './Sheet.js';
export { CommandPalette, filterCommands } from './CommandPalette.js';
export type { Command } from './CommandPalette.js';
export { COMMAND_EVENT, MENU_COMMANDS, isMenuCommand, modalOpen, studioShell } from './commands.js';
export type { MenuCommand, StudioShellFlag } from './commands.js';
