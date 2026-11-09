/**
 * GENERATED — do not edit. The arguments of every op the Studio serves (UI_OPS, in catalogue order), as `/v1/call/<op>`
 * parses them: written by packages/ui/test/studio-ops-gen.ts from the Studio's op table (each op's zod input, the
 * Studio's pinned arguments included); packages/ui/test/studio-ops.test.ts holds this file to it (RETAKE_WRITE_SNAPSHOTS=1
 * on that test after an intended change of an input). The results are the app's own types: data/ops.ts.
 */

/** Each op's arguments: the JSON a page sends. */
export interface StudioOpArgs {
  /** Retake engine */
  engine_info: Record<string, never>;
  /** List projects */
  project_list: Record<string, never>;
  /** Read a project */
  project_get: {
    project: string;
  };
  /** Replace a project README */
  project_update_readme: {
    project: string;
    markdown: string;
    if_match?: string | null;
  };
  /** Validate scenario YAML */
  scenario_validate: {
    project: string;
    yaml: string;
    env?: string;
    until?: string;
    name?: string;
  };
  /** List runs */
  run_list: {
    project: string;
    scenario?: string;
    mode?: "capture" | "dry";
    limit?: number;
  };
  /** Status of a run */
  run_status: {
    project: string;
    run_id: string;
    detail?: "compact" | "full";
    wait_s?: 0;
  };
  /** Cancel a run */
  run_cancel: {
    project: string;
    run_id: string;
  };
  /** List jobs */
  job_list: {
    project?: string;
    state?: readonly ("queued" | "running" | "succeeded" | "failed" | "cancelled" | "interrupted")[];
    limit?: number;
  };
  /** Sessions of personas */
  auth_status: {
    project?: string;
    env?: string;
  };
  /** Sign a persona in */
  auth_login: {
    project: string;
    persona?: string;
    env?: string;
    mode?: "headed";
    wait_s?: 0;
  };
  /** Recent activity */
  activity_list: {
    project?: string;
    limit?: number;
  };
  /** Search the workspace */
  search: {
    q: string;
    project?: string;
    limit?: number;
  };
  /** Projects overview */
  projects_overview: Record<string, never>;
  /** Project board */
  project_board: {
    project: string;
  };
  /** Scenario as blocks */
  scenario_blocks: {
    project: string;
    name: string;
    run?: string;
    env?: string;
  };
  /** Scenario actions */
  scenario_actions: {
    project: string;
    name: string;
    env?: string;
  };
  /** Thumbnails of run steps */
  run_thumbs: {
    project: string;
    run: string;
    keys: readonly string[];
  };
  /** Step forms */
  scenario_forms: Record<string, never>;
  /** Run a scenario from the Studio */
  scenario_run: {
    project: string;
    name: string;
    mode: "dry" | "capture";
    env?: string;
    hash?: string;
    sessions_ack?: readonly string[];
  };
  /** Edit a scenario from the Studio */
  scenario_edit: {
    project: string;
    name: string;
    hash: string;
    edit: {
      kind: "replace_text";
      text: string;
    } | {
      kind: "restore";
      text: string;
      text_hash: string;
    } | {
      kind: "move_step";
      from: {
        scene: string;
        index: number;
        guard: string;
      };
      to: {
        scene: string;
        index: number;
      };
    } | {
      kind: "delete_step";
      at: {
        scene: string;
        index: number;
        guard: string;
      };
    } | {
      kind: "duplicate_step";
      at: {
        scene: string;
        index: number;
        guard: string;
      };
    } | {
      kind: "set_step";
      at: {
        scene: string;
        index: number;
        guard: string;
      };
      changes: readonly ({
        path: readonly string[];
        from?: string | number | boolean;
        to?: string | number | boolean;
      })[];
    } | {
      kind: "insert_step";
      to: {
        scene: string;
        index: number;
      };
      after: string | null;
      action: "open" | "click" | "double_click" | "hover" | "type" | "press" | "select" | "wait" | "wait_for" | "hold" | "screenshot" | "scroll" | "menu" | "date" | "notify" | "hook";
      values: { [key: string]: string | number | boolean };
    } | {
      kind: "set_field";
      at: {
        entry: "top";
      } | {
        entry: "scene" | "card" | "interstitial";
        id: string;
        guard: string;
      };
      field: "frame" | "intro" | "intro.component" | "intro.duration" | "outro" | "outro.component" | "outro.duration" | "caption_component" | "template" | "transition" | "speed" | "card.component" | "card.duration" | "card.transition" | "interstitial.component" | "interstitial.duration";
      from?: string | number | boolean;
      to?: string | number | boolean;
    };
  };
  /** Pause or resume a run */
  run_pause: {
    project: string;
    run_id: string;
    paused: boolean;
  };
  /** Sessions a scenario needs */
  scenario_sessions: {
    project: string;
    name: string;
    env?: string;
    mode?: "dry" | "capture";
  };
  /** Stop a sign-in */
  sign_in_cancel: {
    job: string;
  };
  /** A scenario's timeline */
  timeline_view: {
    project: string;
    name: string;
    run?: string;
    lease?: string;
    proposal?: {
      comment_id: string;
      entry_id: string;
    };
  };
  /** Leave a timeline */
  timeline_leave: {
    project: string;
    lease: string;
  };
  /** Allow a workspace component in the preview */
  preview_allow: {
    id: string;
    hash: string;
  };
  /** Render a scenario from the Studio */
  scenario_render: {
    project: string;
    name: string;
    run: string;
    expect_edit_sha256: string;
  };
  /** A scenario's renders */
  scenario_renders: {
    project: string;
    name: string;
  };
  /** Cancel a render */
  render_cancel: {
    project: string;
    job: string;
  };
  /** A render's review */
  render_review: {
    project: string;
    render_id: string;
  };
  /** A contact sheet of a review */
  review_image: {
    project: string;
    render_id: string;
    image: string;
  };
  /** Export a render as MP4 from the Studio */
  review_export: {
    project: string;
    render_id: string;
  };
  /** A scenario's comment threads */
  threads_list: {
    project: string;
    name: string;
    status?: "open" | "resolved" | "all";
    render?: string;
    limit?: number;
  };
  /** Comment counts */
  threads_counts: {
    project: string;
    name?: string;
  };
  /** A comment thread */
  thread_get: {
    project: string;
    comment_id: string;
    entry_id?: string;
  };
  /** A thread's still */
  thread_still: {
    project: string;
    comment_id: string;
  };
  /** A render's frames */
  render_outline: {
    project: string;
    render_id: string;
    created_at?: string;
  };
  /** A frame of a render */
  render_frame: {
    project: string;
    render_id: string;
    created_at: string;
    frame: number;
    session: string;
  };
  /** Where a frame comment points */
  frame_anchor: {
    project: string;
    render_id: string;
    created_at: string;
    frame: number;
    region?: {
      x: number;
      y: number;
      w: number;
      h: number;
    };
  };
  /** Comment a frame */
  thread_add: {
    project: string;
    render_id: string;
    created_at: string;
    frame: number;
    region?: {
      x: number;
      y: number;
      w: number;
      h: number;
    };
    text: string;
  };
  /** Reply to a thread */
  thread_reply: {
    project: string;
    comment_id: string;
    text: string;
  };
  /** Resolve a thread */
  thread_resolve: {
    project: string;
    comment_id: string;
    note: string;
    render_id?: string;
    if_match: string;
  };
  /** Reopen a thread */
  thread_reopen: {
    project: string;
    comment_id: string;
    note?: string;
    if_match: string;
  };
  /** Apply Claude's proposal */
  thread_apply: {
    project: string;
    comment_id: string;
    entry_id: string;
    if_match: string;
  };
  /** The component library */
  library_view: {
    project: string;
    theme?: string;
  };
  /** Library posters and loops */
  library_images: {
    project: string;
    keys?: readonly string[];
    committed?: readonly string[];
  };
  /** Render library previews */
  library_render: {
    project: string;
    theme?: string;
    items: readonly {
      component: string;
      poster?: string;
      loop?: string;
    }[];
    retry?: boolean;
  };
  /** One component of the library */
  library_component: {
    project: string;
    component: string;
  };
  /** The themes of the workspace */
  theme_list: {
    project: string;
  };
  /** A theme in the editor */
  theme_view: {
    theme: string;
  };
  /** Edit a theme from the Studio */
  theme_edit: {
    theme: string;
    if_match: string;
    edit: {
      kind: "set_field";
      field: "colors.accent" | "colors.text" | "colors.muted" | "colors.paper" | "colors.dark" | "background.from" | "background.to" | "background.color" | "cursor.style" | "cursor.ripple_color" | "brand.name" | "brand.url" | "outro.url" | "outro.tagline" | "style_bias" | "motion.max_zoom" | "motion.default_zoom" | "logo" | "wordmark" | "fonts.display" | "fonts.body";
      from?: string | number | readonly string[];
      to?: string | number | readonly string[];
      ripple?: boolean;
    } | {
      kind: "set_background";
      from?: { [key: string]: string | number };
      to: {
        type: "solid";
        color: string;
      } | {
        type: "radial" | "linear";
        from: string;
        to: string;
      };
    } | {
      kind: "set_component";
      component: "intro" | "outro" | "card" | "interstitial" | "caption" | "layout" | "overlay" | "transition";
      from?: string | null;
      id: string | null;
      params: "keep" | "drop";
    } | {
      kind: "restore";
      text: string;
      text_hash: string;
    };
  };
  /** Copy a theme to edit it */
  theme_copy: {
    from: string;
    name: string;
  };
  /** New theme from brand files */
  theme_create: {
    name: string;
    base?: string;
    colors: {
      accent: string;
      text?: string;
      paper?: string;
      muted?: string;
      dark?: string;
    };
    background?: string | {
      type: "radial" | "linear";
      from: string;
      to: string;
    };
    adjust?: boolean;
    logo: string;
    wordmark?: string;
    fonts?: {
      display?: string | {
        file: string;
        weight?: number;
        italic?: boolean;
      };
      body?: readonly (string | {
        file: string;
        weight?: number;
        italic?: boolean;
      })[];
    };
    brand?: {
      name?: string;
      url?: string;
    };
  };
  /** Brand files of the workspace */
  brand_files: {
    kind: "image" | "font";
  };
  /** Site extractions */
  site_list: {
    url?: string;
  };
  /** A theme's live preview */
  theme_preview: {
    project: string;
    theme: string;
    target: "intro" | "clip" | "outro" | {
      component: string;
    };
    draft?: {
      colors?: {
        accent?: string;
        text?: string;
        muted?: string;
        paper?: string;
        dark?: string;
      };
      background?: {
        type: "solid";
        color: string;
      } | {
        type: "radial" | "linear";
        from: string;
        to: string;
      };
    };
    lease: string;
  };
  /** Recording: start form */
  record_options: {
    project: string;
  };
  /** Recording: open the window */
  record_start: {
    project: string;
    env?: string;
    page?: string;
    path?: string;
    persona?: string;
    name?: string;
  };
  /** Recording: live view */
  record_view: {
    project: string;
    rec_id: string;
    job?: string;
    since?: string;
  };
  /** Recording: arrange the draft */
  record_annotate: {
    project: string;
    rec_id: string;
    rev: number;
    change: {
      op: "choose";
      seq: number;
      index: number;
    } | {
      op: "insert";
      at: "end" | {
        after_step_seq: number;
        row?: "wait";
      } | {
        after_insert: string;
      };
      insert: {
        kind: "hold";
        seconds: number;
      } | {
        kind: "wait_for";
        until: "next_target" | "idle" | "text";
        text?: string;
      } | {
        kind: "caption";
        text: string;
        kicker?: string;
      } | {
        kind: "mark";
        name?: string;
      } | {
        kind: "camera";
        zoom: number;
        until: "scene_end" | "step_end";
      };
    } | {
      op: "remove";
      id: string;
    };
  };
  /** Recording: stop and keep */
  record_stop: {
    project: string;
    rec_id: string;
    job?: string;
  };
  /** Recording: discard */
  record_discard: {
    project: string;
    rec_id: string;
    job?: string;
  };
  /** Recording: save as a scenario */
  record_save: {
    project: string;
    rec_id: string;
    name: string;
    rev: number;
    draft: string;
  };
  /** Report unsaved text */
  unsaved_report: {
    tab: string;
    hidden: boolean;
    items: readonly ({
      kind: "readme" | "yaml_draft" | "step_form" | "comment" | "component_brief" | "new_theme" | "theme_draft";
      project?: string;
      scenario?: string;
    })[];
  };
  /** Answer the desktop app */
  desktop_answer: {
    id: string;
    shown: true;
  } | {
    id: string;
    answer: "proceed" | "cancel";
  };
  /** Set-up of the installed app */
  setup_status: {
    processes?: boolean;
  };
  /** Install the retake command */
  setup_cli_install: {
    folder?: "default" | "chosen";
    replace?: boolean;
  };
  /** Choose the command's folder */
  setup_cli_choose: Record<string, never>;
  /** Uninstall the retake command */
  setup_cli_remove: Record<string, never>;
  /** Register with Claude Code */
  setup_claude_code_run: Record<string, never>;
  /** Add to Claude Desktop */
  setup_claude_desktop_add: {
    replace?: boolean;
  };
  /** Allow notifications */
  setup_notifications: Record<string, never>;
  /** Close the set-up */
  setup_done: Record<string, never>;
  /** Updates of the desktop app */
  desktop_update_status: Record<string, never>;
  /** Install the update, or later */
  desktop_update: {
    action: "install" | "later";
  };
}

/** An op the Studio serves (`POST /v1/call/<op>`). */
export type StudioOp = keyof StudioOpArgs;
