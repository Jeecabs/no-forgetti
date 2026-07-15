import {
  DynamicBorder,
  getMarkdownTheme,
  type ExtensionCommandContext,
  type KeybindingsManager,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import {
  Container,
  Key,
  Markdown,
  matchesKey,
  type SelectItem,
  SelectList,
  Text,
  truncateToWidth,
  type TUI,
} from "@earendil-works/pi-tui";

import type { ProjectSkill } from "./skill-types.ts";

export type SkillViewerAction = "back" | "close" | "edit" | "next" | "previous";
export type SkillPickerAction = { action: "open" | "edit"; name: string };

function usageSummary(skill: ProjectSkill): string {
  return `${skill.useSessionCount} sessions  ${skill.useCount} recalls`;
}

export async function showSkillPicker(
  ctx: ExtensionCommandContext,
  skills: ProjectSkill[],
  selectedName?: string,
): Promise<SkillPickerAction | undefined> {
  if (ctx.mode !== "tui" || skills.length === 0) return undefined;

  const actions = new Map<string, SkillPickerAction>();
  const items: SelectItem[] = skills.map((skill) => {
    actions.set(skill.name, { action: "open", name: skill.name });
    return { value: skill.name, label: skill.name, description: `${skill.description}  ${usageSummary(skill)}` };
  });

  const result = await ctx.ui.custom<SkillPickerAction | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const border = new DynamicBorder((text: string) => theme.fg("borderAccent", text));
    container.addChild(border);
    container.addChild(new Text(theme.fg("accent", theme.bold("No Forgetti / Project skills")), 1, 0));
    container.addChild(new Text(
      theme.fg("muted", `${skills.length} active skills  External project store`),
      1,
      0,
    ));

    const listRows = Math.min(12, Math.max(4, items.length), Math.max(4, tui.terminal.rows - 8));
    const list = new SelectList(items, listRows, {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", theme.bold(text)),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });
    const selectedIndex = selectedName ? items.findIndex((item) => item.value === selectedName) : -1;
    if (selectedIndex >= 0) list.setSelectedIndex(selectedIndex);
    list.onSelect = (item) => done(actions.get(item.value) ?? null);
    list.onCancel = () => done(null);
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate   enter open   e edit   esc close"), 1, 0));
    container.addChild(border);

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        if (data === "e") {
          const item = list.getSelectedItem();
          const action = item ? actions.get(item.value) : undefined;
          if (action?.action === "open") done({ action: "edit", name: action.name });
          return;
        }
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });

  return result ?? undefined;
}

class SkillViewer {
  private readonly markdown: Markdown;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly skill: ProjectSkill;
  private readonly canGoBack: boolean;
  private readonly done: (action: SkillViewerAction) => void;
  private scrollOffset = 0;
  private renderedWidth?: number;
  private renderedBody: string[] = [];

  constructor(
    tui: TUI,
    theme: Theme,
    keybindings: KeybindingsManager,
    skill: ProjectSkill,
    canGoBack: boolean,
    done: (action: SkillViewerAction) => void,
  ) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.skill = skill;
    this.canGoBack = canGoBack;
    this.done = done;
    this.markdown = new Markdown(skill.content, 0, 0, getMarkdownTheme());
  }

  handleInput(data: string): void {
    const navigation = this.navigationAction(data);
    if (navigation) {
      this.done(navigation);
      return;
    }
    const nextOffset = this.nextScrollOffset(data);
    if (nextOffset === undefined) return;
    this.scrollOffset = nextOffset;
    this.tui.requestRender();
  }

  private navigationAction(data: string): SkillViewerAction | undefined {
    if (matchesKey(data, Key.ctrl("c")) || data === "q") return "close";
    const cancel = this.keybindings.matches(data, "tui.select.cancel");
    if (this.canGoBack && (cancel || matchesKey(data, Key.left) || data === "b")) return "back";
    if (cancel) return "close";
    if (data === "e") return "edit";
    if (this.canGoBack && data === "[") return "previous";
    if (this.canGoBack && data === "]") return "next";
    return undefined;
  }

  private nextScrollOffset(data: string): number | undefined {
    const pageSize = this.visibleBodyRows();
    const pageStep = Math.max(1, pageSize - 1);
    const maxOffset = Math.max(0, this.renderedBody.length - pageSize);
    if (this.keybindings.matches(data, "tui.select.up") || data === "k") return Math.max(0, this.scrollOffset - 1);
    if (this.keybindings.matches(data, "tui.select.down") || data === "j") return Math.min(maxOffset, this.scrollOffset + 1);
    if (this.keybindings.matches(data, "tui.select.pageUp")) return Math.max(0, this.scrollOffset - pageStep);
    if (this.keybindings.matches(data, "tui.select.pageDown") || matchesKey(data, Key.space)) return Math.min(maxOffset, this.scrollOffset + pageStep);
    if (matchesKey(data, Key.home)) return 0;
    if (matchesKey(data, Key.end)) return maxOffset;
    return undefined;
  }

  render(width: number): string[] {
    const innerWidth = Math.max(1, width - 2);
    if (this.renderedWidth !== innerWidth) {
      this.renderedWidth = innerWidth;
      this.renderedBody = this.markdown.render(innerWidth);
    }
    const pageSize = this.visibleBodyRows();
    const maxOffset = Math.max(0, this.renderedBody.length - pageSize);
    this.scrollOffset = Math.min(this.scrollOffset, maxOffset);
    const visible = this.renderedBody.slice(this.scrollOffset, this.scrollOffset + pageSize);
    const remaining = Math.max(0, this.renderedBody.length - this.scrollOffset - visible.length);
    const title = ` ${this.skill.name} `;
    const meta = `${this.skill.description}  ${usageSummary(this.skill)}  updated ${this.skill.updatedAt.slice(0, 10)}`;
    const position = this.renderedBody.length > pageSize
      ? `${this.scrollOffset + 1}-${this.scrollOffset + visible.length}/${this.renderedBody.length}`
      : `${this.renderedBody.length} lines`;
    const help = `${this.canGoBack ? "b back   [ previous   ] next   " : ""}↑↓ scroll   pgup/pgdn page   e edit   esc close`;

    return [
      this.theme.fg("borderAccent", "─".repeat(Math.max(0, width))),
      truncateToWidth(this.theme.fg("accent", this.theme.bold(title)), width),
      truncateToWidth(this.theme.fg("muted", ` ${meta}`), width),
      "",
      ...visible.map((line) => truncateToWidth(line, width)),
      "",
      truncateToWidth(this.theme.fg("dim", ` ${position}   ${remaining > 0 ? `${remaining} below` : "end"}`), width),
      truncateToWidth(this.theme.fg("dim", ` ${help}`), width),
      this.theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
    ];
  }

  invalidate(): void {
    this.renderedWidth = undefined;
    this.renderedBody = [];
    this.markdown.invalidate();
  }

  private visibleBodyRows(): number {
    return Math.max(5, this.tui.terminal.rows - 9);
  }
}

export async function showSkillViewer(
  ctx: ExtensionCommandContext,
  skill: ProjectSkill,
  canGoBack: boolean,
  presentOutput?: (text: string) => void,
): Promise<SkillViewerAction> {
  if (ctx.mode !== "tui") {
    const output = `${skill.name}: ${skill.description}\n\n${skill.content}`;
    if (presentOutput) presentOutput(output);
    else if (ctx.hasUI) ctx.ui.notify(output, "info");
    else if (ctx.mode === "print") process.stdout.write(`${output}\n`);
    else throw new Error("Project skill reading requires TUI/RPC mode; use the project_skill tool in JSON mode.");
    return "close";
  }
  return ctx.ui.custom<SkillViewerAction>((tui, theme, keybindings, done) => (
    new SkillViewer(tui, theme, keybindings, skill, canGoBack, done)
  ));
}
