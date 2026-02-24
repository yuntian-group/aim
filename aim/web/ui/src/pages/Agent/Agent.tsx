import React, { memo, useEffect, useMemo, useState } from 'react';

import { Paper } from '@material-ui/core';

import BusyLoaderWrapper from 'components/BusyLoaderWrapper/BusyLoaderWrapper';
import ErrorBoundary from 'components/ErrorBoundary/ErrorBoundary';
import { Button, Icon, Text } from 'components/kit';

import agentAppModel from 'services/models/agent/agentAppModel';

import './Agent.scss';

interface IAgentProps {
  agentsList: string[];
  isAgentsDataLoading: boolean;
  isInstructLoading: boolean;
  instructResult: any;
}

function Agent({
  agentsList,
  isAgentsDataLoading,
  isInstructLoading,
  instructResult,
}: IAgentProps): React.FunctionComponentElement<React.ReactNode> {
  const [selectedAgent, setSelectedAgent] = useState<string | null>(null);
  const [contextInfo, setContextInfo] = useState('');
  const [hypothesisPrompt, setHypothesisPrompt] = useState('');
  const [selectedHypothesis, setSelectedHypothesis] = useState('');
  const [storedHypotheses, setStoredHypotheses] = useState<string[]>([]);
  const [lastInstructType, setLastInstructType] = useState('');
  const [selectedDevPlan, setSelectedDevPlan] = useState('');
  const [numIterations, setNumIterations] = useState<number>(2);

  function handleRefresh() {
    agentAppModel.getAgentsData().call();
  }

  function sendInstruction(type: string, payload: string) {
    if (!selectedAgent || !payload.trim()) return;
    setLastInstructType(type);
    agentAppModel
      .instructAgent(selectedAgent, {
        type,
        payload,
      })
      .call();
  }

  function handleContextSubmit() {
    sendInstruction('update_context_info', contextInfo);
  }

  function handleHypothesisGenerationSubmit() {
    sendInstruction('codex_hypothesis_generation', hypothesisPrompt);
  }

  function handleHypothesisSelectionSubmit() {
    sendInstruction('codex_hypothesis_selection', selectedHypothesis);
  }

  function handleRunLoopSubmit() {
    sendInstruction('run_react_loop', String(numIterations));
  }

  function handleDevPlanSubmit() {
    sendInstruction('codex_dev_plan_selection', selectedDevPlan);
  }

  function handleTextareaSubmit(
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    submit: () => void,
  ) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  useEffect(() => {
    if (
      lastInstructType === 'codex_hypothesis_generation' &&
      instructResult?.status === 'completed' &&
      instructResult?.result
    ) {
      try {
        const parsed = JSON.parse(instructResult.result);
        if (Array.isArray(parsed)) {
          setStoredHypotheses(parsed.map((item: any) => String(item)));
        }
      } catch {
        // result is not a valid JSON array
      }
    }
  }, [instructResult, lastInstructType]);

  const selectedHypothesisContent =
    selectedHypothesis || storedHypotheses[0] || '';
  const devPlanCandidates = useMemo(() => {
    const result =
      instructResult?.status === 'completed' ? instructResult?.result : '';
    if (typeof result === 'string') {
      try {
        const parsed = JSON.parse(result);
        if (Array.isArray(parsed)) {
          return parsed.map((item) => String(item));
        }
      } catch {
        // fallback to current hypothesis selection
      }
    }

    return selectedHypothesis ? [selectedHypothesis] : [];
  }, [instructResult, selectedHypothesis]);
  const selectedDevPlanContent = selectedDevPlan || devPlanCandidates[0] || '';

  const isAgentDisabled = !selectedAgent || isInstructLoading;

  return (
    <ErrorBoundary>
      <section className='Agent container'>
        <div className='Agent__header'>
          <Text size={18} weight={600} component='h2'>
            Agents
          </Text>
          <Button variant='outlined' size='small' onClick={handleRefresh}>
            <Icon name='reset' fontSize={14} />
            <span style={{ marginLeft: 4 }}>Refresh</span>
          </Button>
        </div>

        <div className='Agent__content'>
          <Paper className='Agent__list'>
            <Text size={14} weight={600} className='Agent__list__title'>
              Connected Agents
            </Text>
            <BusyLoaderWrapper isLoading={isAgentsDataLoading} height='100%'>
              {agentsList && agentsList.length > 0 ? (
                <ul className='Agent__list__items'>
                  {agentsList.map((runHash: string) => (
                    <li
                      key={runHash}
                      className={`Agent__list__item ${
                        selectedAgent === runHash
                          ? 'Agent__list__item--active'
                          : ''
                      }`}
                      onClick={() => setSelectedAgent(runHash)}
                    >
                      <Icon name='runs' fontSize={14} />
                      <Text
                        size={13 as any}
                        className='Agent__list__item__hash'
                      >
                        {runHash}
                      </Text>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className='Agent__list__empty'>
                  <Text size={13 as any} color='info'>
                    No agents connected
                  </Text>
                </div>
              )}
            </BusyLoaderWrapper>
          </Paper>

          <Paper className='Agent__instruct'>
            <Text size={14} weight={600} className='Agent__instruct__title'>
              Agent Workflow
              {selectedAgent && (
                <Text
                  size={12}
                  weight={400}
                  color='info'
                  className='Agent__instruct__selected'
                >
                  &nbsp;to {selectedAgent}
                </Text>
              )}
            </Text>

            <div className='Agent__workflow'>
              <div className='Agent__workflow__section'>
                <Text size={12} weight={600} className='Agent__workflow__label'>
                  1. Update Context Info
                </Text>
                <div className='Agent__instruct__input'>
                  <textarea
                    className='Agent__instruct__textarea'
                    placeholder={
                      selectedAgent
                        ? 'Describe context information...'
                        : 'Select an agent first'
                    }
                    value={contextInfo}
                    onChange={(e) => setContextInfo(e.target.value)}
                    onKeyDown={(e) =>
                      handleTextareaSubmit(e, handleContextSubmit)
                    }
                    disabled={isAgentDisabled}
                    rows={3}
                  />
                  <Button
                    variant='contained'
                    color='primary'
                    size='small'
                    onClick={handleContextSubmit}
                    disabled={isAgentDisabled || !contextInfo.trim()}
                    className='Agent__instruct__sendBtn'
                  >
                    {isInstructLoading ? 'Sending...' : 'Submit'}
                  </Button>
                </div>
              </div>

              <div className='Agent__workflow__section'>
                <Text size={12} weight={600} className='Agent__workflow__label'>
                  2. Generate Hypotheses
                </Text>
                <div className='Agent__instruct__input'>
                  <textarea
                    className='Agent__instruct__textarea'
                    placeholder={
                      selectedAgent
                        ? 'Provide hypothesis generation guidance...'
                        : 'Select an agent first'
                    }
                    value={hypothesisPrompt}
                    onChange={(e) => setHypothesisPrompt(e.target.value)}
                    onKeyDown={(e) =>
                      handleTextareaSubmit(e, handleHypothesisGenerationSubmit)
                    }
                    disabled={isAgentDisabled}
                    rows={3}
                  />
                  <Button
                    variant='contained'
                    color='primary'
                    size='small'
                    onClick={handleHypothesisGenerationSubmit}
                    disabled={isAgentDisabled || !hypothesisPrompt.trim()}
                    className='Agent__instruct__sendBtn'
                  >
                    {isInstructLoading ? 'Sending...' : 'Submit'}
                  </Button>
                </div>
              </div>

              <div className='Agent__workflow__section'>
                <Text size={12} weight={600} className='Agent__workflow__label'>
                  3. Select Hypothesis
                </Text>
                <div className='Agent__workflow__selection'>
                  <select
                    className='Agent__workflow__select'
                    value={selectedHypothesis}
                    onChange={(e) => setSelectedHypothesis(e.target.value)}
                    disabled={isAgentDisabled || storedHypotheses.length === 0}
                  >
                    <option value=''>
                      {storedHypotheses.length > 0
                        ? 'Select one hypothesis'
                        : 'No hypotheses available'}
                    </option>
                    {storedHypotheses.map((item: string) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant='contained'
                    color='primary'
                    size='small'
                    onClick={handleHypothesisSelectionSubmit}
                    disabled={isAgentDisabled || !selectedHypothesis}
                    className='Agent__instruct__sendBtn'
                  >
                    {isInstructLoading ? 'Sending...' : 'Submit'}
                  </Button>
                </div>
                <Paper className='Agent__workflow__preview' elevation={0}>
                  <Text size={12} weight={600}>
                    Selected Hypothesis Detail
                  </Text>
                  <pre className='Agent__workflow__preview__body'>
                    {selectedHypothesisContent ||
                      'Select a hypothesis to view details.'}
                  </pre>
                </Paper>
              </div>

              <div className='Agent__workflow__section'>
                <Text size={12} weight={600} className='Agent__workflow__label'>
                  4. Dev Doc Generation (Prober Script)
                </Text>
                <div className='Agent__workflow__selection'>
                  <select
                    className='Agent__workflow__select'
                    value={selectedDevPlan}
                    onChange={(e) => setSelectedDevPlan(e.target.value)}
                    disabled={isAgentDisabled || devPlanCandidates.length === 0}
                  >
                    <option value=''>
                      {devPlanCandidates.length > 0
                        ? 'Select one dev plan'
                        : 'No dev plans available'}
                    </option>
                    {devPlanCandidates.map((item: string) => (
                      <option key={item} value={item}>
                        {item}
                      </option>
                    ))}
                  </select>
                  <Button
                    variant='contained'
                    color='primary'
                    size='small'
                    onClick={handleDevPlanSubmit}
                    disabled={isAgentDisabled || !selectedDevPlan}
                    className='Agent__instruct__sendBtn'
                  >
                    {isInstructLoading ? 'Sending...' : 'Submit'}
                  </Button>
                </div>
                <Paper className='Agent__workflow__preview' elevation={0}>
                  <Text size={12} weight={600}>
                    Selected Dev Plan Detail
                  </Text>
                  <pre className='Agent__workflow__preview__body'>
                    {selectedDevPlanContent ||
                      'Select a dev plan to view details.'}
                  </pre>
                </Paper>
              </div>

              <div className='Agent__workflow__section'>
                <Text size={12} weight={600} className='Agent__workflow__label'>
                  5. Run Optimization Loop
                </Text>
                <div className='Agent__workflow__loop'>
                  <input
                    className='Agent__workflow__numberInput'
                    type='number'
                    min={1}
                    value={numIterations}
                    onChange={(e) =>
                      setNumIterations(Math.max(1, Number(e.target.value) || 1))
                    }
                    disabled={isAgentDisabled}
                  />
                  <Button
                    variant='contained'
                    color='primary'
                    size='small'
                    onClick={handleRunLoopSubmit}
                    disabled={isAgentDisabled}
                    className='Agent__instruct__sendBtn'
                  >
                    {isInstructLoading ? 'Sending...' : 'Start'}
                  </Button>
                </div>
              </div>
            </div>

            {instructResult && (
              <Paper className='Agent__instruct__result' elevation={0}>
                <Text size={12} weight={600}>
                  Response ({instructResult.status})
                </Text>
                <pre className='Agent__instruct__result__body'>
                  {instructResult.status === 'completed'
                    ? instructResult.result
                    : instructResult.error}
                </pre>
              </Paper>
            )}
          </Paper>
        </div>
      </section>
    </ErrorBoundary>
  );
}

export default memo(Agent);
