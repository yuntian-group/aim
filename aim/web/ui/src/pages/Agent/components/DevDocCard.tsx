import React from 'react';

import { Button, Text } from 'components/kit';

import { DevDoc } from '../parseCodexResult';

interface DevDocCardProps {
  id: string;
  doc: DevDoc;
  onCompare: (id: string, doc: DevDoc) => void;
  onToggleKeep?: (id: string, nextSelected: boolean) => void;
  keepDisabled?: boolean;
  keepPending?: boolean;
}

function DevDocCard({
  id,
  doc,
  onCompare,
  onToggleKeep,
  keepDisabled = false,
  keepPending = false,
}: DevDocCardProps) {
  const [isExpanded, setIsExpanded] = React.useState(false);

  const handleToggle = React.useCallback(() => {
    const next = !isExpanded;
    setIsExpanded(next);
    console.log({
      kind: 'DEV_DOC',
      action: 'toggle_details',
      id: doc.doc_id,
      open: next,
    });
  }, [doc.doc_id, isExpanded]);

  const handleCopy = React.useCallback(() => {
    const payload = JSON.stringify(doc, null, 2);
    if (navigator?.clipboard?.writeText) {
      navigator.clipboard.writeText(payload).catch(() => {
        console.log({
          kind: 'DEV_DOC',
          action: 'copy_fallback',
          id: doc.doc_id,
          payload,
        });
      });
    } else {
      console.log({ kind: 'DEV_DOC', action: 'copy', id: doc.doc_id, payload });
    }
  }, [doc]);

  const handleCompare = React.useCallback(() => {
    onCompare(id, doc);
  }, [id, doc, onCompare]);

  const handleKeepToggle = React.useCallback(() => {
    if (typeof onToggleKeep === 'function') {
      onToggleKeep(id, !Boolean(doc.selected));
    }
  }, [id, doc.selected, onToggleKeep]);

  const metricName = doc.metric?.name ?? '—';
  const metricThreshold = doc.metric?.threshold ?? '—';
  const strengths = Array.isArray(doc.strengths) ? doc.strengths : [];
  const weaknesses = Array.isArray(doc.weaknesses) ? doc.weaknesses : [];

  return (
    <div className='Agent__devDocCard'>
      <div className='Agent__devDocCard__header'>
        <Text size={14} weight={600} className='Agent__devDocCard__title'>
          {doc.title || 'Untitled doc'}
        </Text>
        <Text size={11} color='info'>
          ID: {doc.doc_id || 'n/a'}
        </Text>
      </div>
      <div className='Agent__devDocCard__meta'>
        <Text size={11} color='primary' tint={60}>
          Confidence: {doc.confidence || 'n/a'}
        </Text>
        <Text size={11} color='primary' tint={60}>
          Metric: {metricName} / {metricThreshold}
        </Text>
      </div>
      <p className='Agent__devDocCard__expectation'>
        {doc.expectation || '(no expectation provided)'}
      </p>
      <div className='Agent__devDocCard__lists'>
        <div>
          <Text size={11} weight={600}>
            Strengths ({strengths.length})
          </Text>
          <ul>
            {strengths.slice(0, 2).map((item, idx) => (
              <li key={`strength_${doc.doc_id}_${idx}`}>{item}</li>
            ))}
          </ul>
        </div>
        <div>
          <Text size={11} weight={600}>
            Weaknesses ({weaknesses.length})
          </Text>
          <ul>
            {weaknesses.slice(0, 2).map((item, idx) => (
              <li key={`weakness_${doc.doc_id}_${idx}`}>{item}</li>
            ))}
          </ul>
        </div>
      </div>
      <div className='Agent__cardActions'>
        <Button
          variant={doc.selected ? 'contained' : 'outlined'}
          size='small'
          onClick={handleKeepToggle}
          disabled={keepDisabled || keepPending}
          className='Agent__cardActions__button'
        >
          {keepPending ? 'Saving...' : doc.selected ? 'Unkeep' : 'Keep'}
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
          onClick={handleToggle}
          className='Agent__cardActions__button'
        >
          {isExpanded ? 'Hide details' : 'Open details'}
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
      {isExpanded && (
        <div className='Agent__devDocCard__details'>
          <Text size={11} weight={600}>
            Computation
          </Text>
          <pre className='Agent__devDocCard__detailsBody'>
            {JSON.stringify(
              {
                computation: doc.computation,
                outputs: doc.outputs,
              },
              null,
              2,
            )}
          </pre>
        </div>
      )}
    </div>
  );
}

export default React.memo(DevDocCard);
