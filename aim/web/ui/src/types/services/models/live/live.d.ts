// Types for the interactive-training Control Protocol (design doc §3) and the Aim
// Live proxy API (§5). Field names mirror the wire contract exactly — never rename.

export type LiveStatus = 'idle' | 'running' | 'paused' | 'stopped' | 'ended';

export interface IGoal {
  name: string;
  metric: string;
  direction: 'min' | 'max';
  target: number | null;
}

// A tunable hyperparameter ("knob" on the wire). See §3.2.
export interface IKnobView {
  name: string;
  value: any;
  dtype: 'float' | 'int' | 'bool' | 'str' | string;
  min: number | null;
  max: number | null;
  step: number | null;
  description?: string;
}

// A self-describing action the trainer accepts on POST /actions. See §3.2 / §3.6.
export interface IActionSchema {
  type: string;
  description?: string;
  payload_keys: string[];
}

export interface IAgentInfo {
  attached: boolean;
  active: boolean;
  model?: string | null;
  provider?: string | null;
  base_url?: string | null;
  reasoning_effort?: string | null;
  every?: number | null;
  api_key_set?: boolean;
}

export interface IBranch {
  id: string;
  parent: string | null;
  from_checkpoint: string | null;
  created_at: number;
}

export interface ICheckpoint {
  id: string;
  path: string;
  step: number;
  tag: string | null;
  branch_id: string;
  ts: number;
}

export interface IModelTreeNode {
  name: string;
  module_type: string;
  children?: IModelTreeNode[];
}

// Full session snapshot returned by GET /state (§3.2).
export interface IControlState {
  status: LiveStatus;
  goal: IGoal | null;
  knobs: IKnobView[];
  actions: IActionSchema[];
  agent: IAgentInfo;
  context?: string;
  step: number;
  branch_id: string;
  branches: IBranch[];
  checkpoints: ICheckpoint[];
  model_tree: IModelTreeNode | null;
  v?: number;
}

// A single event on the stream (§3.4 / §3.5).
export interface IControlEvent {
  v: number;
  seq: number;
  type: string;
  payload: Record<string, any>;
  ts: number;
  branch_id: string;
}

// An action submitted via POST /actions (§3.3).
export interface IControlAction {
  type: string;
  payload?: Record<string, any>;
  source?: string;
  id?: string;
}

// A discovered live session (proxy GET /api/live/ — §5.2).
export interface ILiveSession {
  run_hash: string;
  experiment: string;
  round: number;
  status: LiveStatus;
  reachable: boolean;
  goal: IGoal | null;
  step: number | null;
  run_hashes: string[];
}

export interface ILiveSessionsResponse {
  sessions: ILiveSession[];
}
