import React from 'react';

import { Button, Text } from 'components/kit';

import { ProbeIdea } from '../parseCodexResult';

interface ProbeIdeaCardProps {
  id: string;
  probe: ProbeIdea;
  onCompare: (id: string, probe: ProbeIdea) => void;
  onToggleKeep?: (id: string, nextSelected: boolean) => void;
  keepDisabled?: boolean;
  keepPending?: boolean;
}

function ProbeIdeaCard({
  id,
  probe,
  onCompare,
  onToggleKeep,
  keepDisabled = false,
  keepPending = false,
}: ProbeIdeaCardProps) {
  const handleCompare = React.useCallback(() => {
    onCompare(id, probe);
  }, [id, probe, onCompare]);

  const handleCopy = React.useCallback(() => {
    const payload = JSON.stringify(probe, null, 2);
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(payload).catch(() => {
        console.log({
          kind: 'PROBE_IDEA',
          action: 'copy_fallback',
          id,
          payload,
        });
      });
    } else {
      console.log({ kind: 'PROBE_IDEA', action: 'copy', id, payload });
    }
  }, [id, probe]);

  const handleToggleKeep = React.useCallback(() => {
    if (typeof onToggleKeep === 'function') {
      onToggleKeep(id, !Boolean(probe.selected));
    }
  }, [id, probe.selected, onToggleKeep]);

  return (
    <div className='Agent__probeCard'>
      <div className='Agent__probeCard__header'>
        <Text size={14} weight={600} className='Agent__probeCard__title'>
          {probe.probe_name || 'Untitled probe'}
        </Text>
        <Text size={11} color='info'>
          {probe.probe_type || 'Unknown type'}
        </Text>
      </div>
      <div className='Agent__probeCard__meta'>
        <Text size={11} color='primary' tint={60}>
          Confidence: {probe.confidence || 'n/a'}
        </Text>
        <Text size={11} color='primary' tint={60}>
          Reference: {probe.reference || '(none)'}
        </Text>
      </div>
      <p className='Agent__probeCard__explanation'>
        {probe.explanation || '(no explanation provided)'}
      </p>
      <div className='Agent__cardActions'>
        <Button
          variant={probe.selected ? 'contained' : 'outlined'}
          size='small'
          onClick={handleToggleKeep}
          disabled={keepDisabled || keepPending}
          className='Agent__cardActions__button'
        >
          {keepPending ? 'Saving...' : probe.selected ? 'Unkeep' : 'Keep'}
        </Button>
        <Button
          variant='outlined'
          size='small'
          onClick={handleCompare}
          className='Agent__cardActions__button'
        >
          Compare
        </Button>
        <Button
          variant='text'
          size='small'
          onClick={handleCopy}
          className='Agent__cardActions__button'
        >
          Copy JSON
        </Button>
      </div>
    </div>
  );
}

export default React.memo(ProbeIdeaCard);
