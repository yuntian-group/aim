import React from 'react';

import { Button, Text } from 'components/kit';

import agentService from 'services/api/agent/agentService';

import { DevDoc } from '../parseCodexResult';

import JsonComparePanel from './JsonComparePanel';
import DevDocCard from './DevDocCard';

interface DevDocGridProps {
  docs: DevDoc[];
}

type DevSelection = {
  left: { id: string; doc: DevDoc } | null;
  right: { id: string; doc: DevDoc } | null;
};

function DevDocGrid({ docs }: DevDocGridProps) {
  const [selection, setSelection] = React.useState<DevSelection>({
    left: null,
    right: null,
  });
  const [savedDocMap, setSavedDocMap] = React.useState<Record<string, DevDoc>>(
    {},
  );
  const [isSaving, setIsSaving] = React.useState(false);
  const [pendingKeepIds, setPendingKeepIds] = React.useState<Set<string>>(
    () => new Set(),
  );

  const buildSavedDocMap = React.useCallback((data: any) => {
    const list = Array.isArray(data?.DEV_DOC) ? data.DEV_DOC : [];
    const map: Record<string, DevDoc> = {};
    list.forEach((item: DevDoc | any) => {
      if (item && typeof item === 'object' && item.doc_id) {
        map[item.doc_id] = item as DevDoc;
      }
    });
    return map;
  }, []);

  React.useEffect(() => {
    let active = true;
    const request = agentService.getSavedDevDocs();
    request
      .call()
      .then((data: any) => {
        if (!active) return;
        setSavedDocMap(buildSavedDocMap(data));
      })
      .catch((err: any) => {
        if (!active) return;
        console.warn('Failed to load saved dev docs', err);
      });

    return () => {
      active = false;
      request.abort();
    };
  }, [buildSavedDocMap]);

  const mappedDocs = React.useMemo(
    () =>
      docs.map((doc) => {
        const saved = doc.doc_id ? savedDocMap[doc.doc_id] : undefined;
        return {
          ...doc,
          selected: saved?.selected ?? false,
        };
      }),
    [docs, savedDocMap],
  );

  const hasPersistedSet = React.useMemo(() => {
    return Object.keys(savedDocMap).length === 3;
  }, [savedDocMap]);

  const setKeepPending = React.useCallback(
    (docId: string, pending: boolean) => {
      setPendingKeepIds((prev) => {
        const next = new Set(prev);
        if (pending) {
          next.add(docId);
        } else {
          next.delete(docId);
        }
        return next;
      });
    },
    [],
  );

  const handleCompare = React.useCallback((id: string, doc: DevDoc) => {
    setSelection((prev) => {
      if (!prev.left || prev.left.id === id) {
        return {
          left: { id, doc },
          right: prev.right && prev.right.id === id ? null : prev.right,
        };
      }
      if (!prev.right && prev.left.id !== id) {
        return { ...prev, right: { id, doc } };
      }
      if (prev.right && prev.right.id === id) {
        return prev;
      }
      return { ...prev, right: { id, doc } };
    });
  }, []);

  const handleClear = React.useCallback(
    () => setSelection({ left: null, right: null }),
    [],
  );

  const handleSwap = React.useCallback(() => {
    setSelection((prev) => {
      if (!prev.left || !prev.right) {
        return prev;
      }
      return { left: prev.right, right: prev.left };
    });
  }, []);

  const handleSaveCurrent = React.useCallback(() => {
    if (!docs?.length) {
      return;
    }
    setIsSaving(true);
    const request = agentService.saveDevDocsFull(docs);
    request
      .call()
      .then((data: any) => {
        setSavedDocMap(buildSavedDocMap(data));
      })
      .catch((err: any) => {
        console.error('Failed to save dev docs', err);
      })
      .finally(() => {
        setIsSaving(false);
      });
  }, [docs, buildSavedDocMap]);

  const handleToggleKeep = React.useCallback(
    (docId: string, nextSelected: boolean) => {
      if (!hasPersistedSet || !docId) {
        return;
      }
      setKeepPending(docId, true);
      const request = agentService.patchDevDoc(docId, {
        selected: nextSelected,
      });
      request
        .call()
        .then((data: any) => {
          setSavedDocMap(buildSavedDocMap(data));
        })
        .catch((err: any) => {
          console.error('Failed to update dev doc', err);
        })
        .finally(() => {
          setKeepPending(docId, false);
        });
    },
    [buildSavedDocMap, hasPersistedSet, setKeepPending],
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
          Structured: DEV_DOC ({docs.length})
        </Text>
        <Button
          variant='outlined'
          size='small'
          onClick={handleSaveCurrent}
          disabled={isSaving || docs.length !== 3}
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
          kind='DEV_DOC'
          leftTitle={selection.left.doc.title || selection.left.id}
          rightTitle={selection.right?.doc.title || selection.right?.id}
          leftObj={selection.left.doc}
          rightObj={selection.right?.doc}
          onClear={handleClear}
          onSwap={handleSwap}
        />
      )}

      <div className='Agent__devDocGrid'>
        {mappedDocs.map((doc, index) => {
          const id = doc.doc_id || `doc_${index}`;
          return (
            <DevDocCard
              key={id}
              id={id}
              doc={doc}
              onCompare={handleCompare}
              onToggleKeep={handleToggleKeep}
              keepDisabled={
                !hasPersistedSet || docs.length !== 3 || !doc.doc_id
              }
              keepPending={pendingKeepIds.has(id)}
            />
          );
        })}
      </div>
    </div>
  );
}

export default React.memo(DevDocGrid);
