import React from 'react';

import { IActionSchema, IModelTreeNode } from 'types/services/models/live/live';

import { ILiveSessionStore } from '../../liveStore';

import './ModelPanel.scss';

interface IModelPanelProps {
  store: ILiveSessionStore;
  disabled?: boolean;
}

// Display the last dotted segment; the full module path stays in the tooltip
// and is what gets sent as `module_name`.
function shortName(name: string): string {
  const parts = name.split('.');
  return parts[parts.length - 1] || name;
}

function TreeNode({
  node,
  depth,
  expanded,
  onToggle,
  moduleActions,
  pendingModules,
  disabled,
  onAction,
}: {
  node: IModelTreeNode;
  depth: number;
  expanded: Record<string, boolean>;
  onToggle: (name: string, isOpen: boolean) => void;
  moduleActions: IActionSchema[];
  pendingModules: Set<string>;
  disabled?: boolean;
  onAction: (type: string, moduleName: string) => void;
}) {
  const children = node.children || [];
  const hasChildren = children.length > 0;
  const isOpen = expanded[node.name] ?? depth < 2;
  const isPending = pendingModules.has(node.name);
  const isRoot = node.name === 'Model';

  return (
    <div className='ModelNode'>
      <div
        className={`ModelNode__row ${isPending ? 'is-queued' : ''}`}
        style={{ paddingLeft: depth * 14 }}
      >
        <button
          type='button'
          className='ModelNode__caret'
          disabled={!hasChildren}
          onClick={() => onToggle(node.name, isOpen)}
        >
          {hasChildren ? (isOpen ? '▾' : '▸') : '·'}
        </button>
        <span className='ModelNode__name' title={node.name}>
          {shortName(node.name)}
        </span>
        <span className='ModelNode__type'>{node.module_type}</span>
        {!isRoot && moduleActions.length > 0 && (
          <span className='ModelNode__actions'>
            {moduleActions.map((action) => (
              <button
                key={action.type}
                type='button'
                className='ModelNode__action'
                title={`${action.description || action.type} (${node.name})`}
                disabled={disabled || isPending}
                onClick={() => {
                  if (
                    window.confirm(
                      `${action.type} on module “${node.name}”?` +
                        (action.type === 'reset_module'
                          ? ' This re-initializes its parameters.'
                          : ''),
                    )
                  ) {
                    onAction(action.type, node.name);
                  }
                }}
              >
                {action.type.replace(/_module$/, '')}
              </button>
            ))}
          </span>
        )}
      </div>
      {hasChildren && isOpen && (
        <div className='ModelNode__children'>
          {children.map((child) => (
            <TreeNode
              key={child.name}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              moduleActions={moduleActions}
              pendingModules={pendingModules}
              disabled={disabled}
              onAction={onAction}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ModelPanel({
  store,
  disabled,
}: IModelPanelProps): React.FunctionComponentElement<React.ReactNode> {
  const tree = store.state?.model_tree;
  const [expanded, setExpanded] = React.useState<Record<string, boolean>>({});

  // Any action taking a `module_name` is offered on tree nodes (design doc §6.4) —
  // this generalizes reset_module to recipe-registered layer ops (freeze, ...).
  const moduleActions = (store.state?.actions || []).filter((a) =>
    (a.payload_keys || []).includes('module_name'),
  );

  const pendingModules = new Set(
    Object.values(store.pending)
      .filter((p) => p.status === 'queued' && p.payload?.module_name)
      .map((p) => p.payload.module_name as string),
  );

  if (!tree) {
    return (
      <div className='LivePanel'>
        <h3 className='LivePanel__title'>Model</h3>
        <p className='LivePanel__hint'>
          No model bound yet. The module tree appears once the trainer calls
          bind_model (at round start).
        </p>
      </div>
    );
  }

  return (
    <div className='LivePanel ModelPanel'>
      <h3 className='LivePanel__title'>Model</h3>
      <div className='ModelPanel__tree'>
        <TreeNode
          node={tree}
          depth={0}
          expanded={expanded}
          onToggle={(name, isOpen) =>
            setExpanded((prev) => ({ ...prev, [name]: !isOpen }))
          }
          moduleActions={moduleActions}
          pendingModules={pendingModules}
          disabled={disabled}
          onAction={(type, moduleName) =>
            store.submitAction(
              { type, payload: { module_name: moduleName } },
              moduleName,
            )
          }
        />
      </div>
    </div>
  );
}

export default ModelPanel;
