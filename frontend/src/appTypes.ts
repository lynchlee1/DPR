export type ScanStatus = "queued" | "running" | "cancelling" | "cancelled" | "complete" | "error";
export type AnalysisMode = "standard" | "quick";
export type DateOrder = "oldest" | "newest";

const DEFAULT_QUICK_THRESHOLD = 96;
const SETUP_GUIDE_KEY = "photo-sorter-setup-guide-v1";
const REVIEW_GUIDE_KEY = "photo-sorter-review-guide-v1";
const SHOW_SINGLETONS_KEY = "photo-sorter-show-singletons";
const CLEANUP_JSON_KEY = "photo-sorter-cleanup-json";
const ARROW_REPEAT_INTERVAL_KEY = "photo-sorter-arrow-repeat-interval";
const DEFAULT_ARROW_REPEAT_INTERVAL = 250;

export type Photo = {
  id: string;
  name: string;
  path: string;
  relative_path: string;
  captured_at: string;
  time_source: "exif" | "filename" | "modified";
  media_type: "image" | "video";
  width: number;
  height: number;
  size_bytes: number;
  sharpness: number;
  similarity_to_keep: number;
  similarity_by_id: Record<string, number>;
  reference_id: string;
  marked: boolean;
};

export type PhotoGroup = {
  id: string;
  keep_id: string;
  keep_ids: string[];
  images: Photo[];
  member_count: number;
  folder_count: number;
  max_similarity: number;
  min_similarity: number;
  time_start: string;
  time_end: string;
};

export type ScanResult = {
  folder: string;
  folders?: string[];
  threshold: number;
  time_window_seconds: number;
  keeper_strategy: "quality" | "latest";
  include_subfolders: boolean;
  cleanup_json_files: boolean;
  day_limit: number | null;
  date_order: DateOrder;
  selected_date_start: string | null;
  selected_date_end: string | null;
  groups: PhotoGroup[];
  failures: { path: string; reason: string }[];
  stats: {
    found: number;
    selected: number;
    source_folders: number;
    available_days: number;
    selected_days: number;
    analyzed: number;
    videos: number;
    json_files_deleted: number;
    pairs_compared: number;
    matched_pairs: number;
    groups: number;
    similar_groups: number;
    singletons: number;
    marked_count: number;
    marked_bytes: number;
    duration_seconds: number;
  };
};

export type Session = {
  id: string;
  folder: string;
  folders?: string[];
  threshold: number;
  time_window_seconds: number;
  mode: AnalysisMode;
  include_subfolders: boolean;
  cleanup_json_files: boolean;
  day_limit: number | null;
  date_order: DateOrder;
  selected_date_start: string | null;
  selected_date_end: string | null;
  status: ScanStatus;
  phase: "queued" | "indexing" | "analyzing" | "comparing" | "cancelling" | "cancelled" | "complete" | "error";
  completed: number;
  total: number;
  result: ScanResult | null;
  error: string | null;
  reused?: boolean;
};

export type CleanupOutcome = {
  moved: string[];
  failures: { path: string; reason: string }[];
  cancelled?: boolean;
};

export type StorageOutcome = {
  moved: { source: string; destination: string }[];
  failures: { path: string; destination?: string; reason: string }[];
  cancelled?: boolean;
  source_check: {
    is_empty: boolean;
    file_count: number;
    size_bytes: number;
    directories: {
      path: string;
      file_count: number;
      size_bytes: number;
      error: string | null;
    }[];
    errors: { path: string; reason: string }[];
  };
};

export type CalculationCache = {
  total_bytes: number;
  analysis_entry_count: number;
  preview_entry_count: number;
  result_entry_count: number;
  session_count: number;
  groups: {
    name: string;
    path: string;
    total_bytes: number;
    analysis_count: number;
    analysis_bytes: number;
    preview_count: number;
    preview_bytes: number;
    result_count: number;
    result_bytes: number;
  }[];
};

export type CacheDeleteOutcome = {
  folder: string;
  removed_analysis_entries: number;
  removed_analysis_bytes: number;
  removed_preview_entries: number;
  removed_preview_bytes: number;
  removed_result_entries: number;
  removed_session_ids: string[];
};

export type FolderBrowserData = {
  path: string;
  parent: string | null;
  revealed?: string | null;
  folders: { name: string; path: string }[];
  shortcuts: { name: string; path: string }[];
};
