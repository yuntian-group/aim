import React from 'react';

import { Button, Text } from 'components/kit';

import agentService from 'services/api/agent/agentService';

import { ProbeIdea } from '../parseCodexResult';

import JsonComparePanel from './JsonComparePanel';
import ProbeIdeaCard from './ProbeIdeaCard';

interface ProbeIdeaGridProps {
  probes: ProbeIdea[];
}

type SelectionState = {
  left: { id: string; probe: ProbeIdea } | null;
  right: { id: string; probe: ProbeIdea } | null;
};

function ProbeIdeaGrid({ probes }: ProbeIdeaGridProps) {
  const [selection, setSelection] = React.useState<SelectionState>({
    left: null,
    right: null,
  });
  const [savedProbeMap, setSavedProbeMap] = React.useState<
    Record<string, ProbeIdea>
  >({});
  const [isSaving, setIsSaving] = React.useState(false);
  const [pendingKeepIds, setPendingKeepIds] = React.useState<Set<string>>(
    () => new Set(),
  );

  const buildSavedProbeMap = React.useCallback((data: any) => {
    const list = Array.isArray(data?.PROBE_IDEA) ? data.PROBE_IDEA : [];
    const map: Record<string, ProbeIdea> = {};
    list.forEach((item: ProbeIdea | any) => {
      if (item && typeof item === 'object' && item.id) {
        map[item.id] = item as ProbeIdea;
      }
    });
    return map;
  }, []);

  React.useEffect(() => {
    let active = true;
    const request = agentService.getSavedProbeIdeas();
    request
      .call()
      .then((data: any) => {
        if (!active) return;
        setSavedProbeMap(buildSavedProbeMap(data));
      })
      .catch((err: any) => {
        if (!active) return;
        console.warn('Failed to load saved probe ideas', err);
      });

    return () => {
      active = false;
      request.abort();
    };
  }, [buildSavedProbeMap]);

  const mappedProbes = React.useMemo(
    () =>
      probes.map((probe, index) => {
        const id = `probe_${index}`;
        const saved = savedProbeMap[id];
        return {
          ...probe,
          id,
          selected: saved?.selected ?? false,
        };
      }),
    [probes, savedProbeMap],
  );

  const hasPersistedSet = React.useMemo(() => {
    return Object.keys(savedProbeMap).length === 10;
  }, [savedProbeMap]);

  const setKeepPending = React.useCallback((probeId: string, next: boolean) => {
    setPendingKeepIds((prev) => {
      const updated = new Set(prev);
      if (next) {
        updated.add(probeId);
      } else {
        updated.delete(probeId);
      }
      return updated;
    });
  }, []);

  const handleCompare = React.useCallback((id: string, probe: ProbeIdea) => {
    setSelection((prev) => {
      if (!prev.left || prev.left.id === id) {
        return {
          left: { id, probe },
          right: prev.right && prev.right.id === id ? null : prev.right,
        };
      }
      if (!prev.right && prev.left.id !== id) {
        return { ...prev, right: { id, probe } };
      }
      if (prev.right && prev.right.id === id) {
        return prev;
      }
      return { ...prev, right: { id, probe } };
    });
  }, []);

  const handleClear = React.useCallback(() => {
    setSelection({ left: null, right: null });
  }, []);

  const handleSwap = React.useCallback(() => {
    setSelection((prev) => {
      if (!prev.left || !prev.right) {
        return prev;
      }
      return { left: prev.right, right: prev.left };
    });
  }, []);

  const handleSaveCurrent = React.useCallback(() => {
    if (!probes?.length) {
      return;
    }
    setIsSaving(true);
    const request = agentService.saveProbeIdeasFull(probes);
    request
      .call()
      .then((data: any) => {
        setSavedProbeMap(buildSavedProbeMap(data));
      })
      .catch((err: any) => {
        console.error('Failed to save probe ideas', err);
      })
      .finally(() => {
        setIsSaving(false);
      });
  }, [probes, buildSavedProbeMap]);

  const handleToggleKeep = React.useCallback(
    (probeId: string, nextSelected: boolean) => {
      if (!hasPersistedSet) {
        return;
      }
      setKeepPending(probeId, true);
      const request = agentService.patchProbeIdea(probeId, {
        selected: nextSelected,
      });
      request
        .call()
        .then((data: any) => {
          setSavedProbeMap(buildSavedProbeMap(data));
        })
        .catch((err: any) => {
          console.error('Failed to update probe idea', err);
        })
        .finally(() => {
          setKeepPending(probeId, false);
        });
    },
    [buildSavedProbeMap, hasPersistedSet, setKeepPending],
  );

  return (
    <div className='Agent__structuredSection'>
      <div className='Agent__structuredSection__header'>
        <Text
          size={12}
          weight={600}
          color='info'
          className='Agent__structuredSection__title'
        >
          Structured: PROBE_IDEA ({probes.length})
        </Text>
        <Button
          variant='outlined'
          size='small'
          onClick={handleSaveCurrent}
          disabled={isSaving || probes.length !== 10}
        >
          {isSaving ? 'Saving...' : 'Save current set'}
        </Button>
      </div>
      {!hasPersistedSet && (
        <Text size={11} color='info' className='Agent__structuredSection__hint'>
          Save the current set to enable Keep toggles.
        </Text>
      )}

      {selection.left && (
        <JsonComparePanel
          kind='PROBE_IDEA'
          leftTitle={selection.left.probe.probe_name || selection.left.id}
          rightTitle={selection.right?.probe.probe_name || selection.right?.id}
          leftObj={selection.left.probe}
          rightObj={selection.right?.probe}
          onClear={handleClear}
          onSwap={handleSwap}
        />
      )}

      <div className='Agent__probeGrid'>
        {mappedProbes.map((probe, index) => (
          <ProbeIdeaCard
            key={probe.id || `probe_${index}`}
            id={probe.id || `probe_${index}`}
            probe={probe}
            onCompare={handleCompare}
            onToggleKeep={handleToggleKeep}
            keepDisabled={!hasPersistedSet || probes.length !== 10}
            keepPending={pendingKeepIds.has(probe.id || `probe_${index}`)}
          />
        ))}
      </div>
    </div>
  );
}

export default React.memo(ProbeIdeaGrid);
