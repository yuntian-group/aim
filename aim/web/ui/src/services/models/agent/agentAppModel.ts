import agentService from 'services/api/agent/agentService';

import createModel from '../model';

const model = createModel<any>({
  isAgentsDataLoading: false,
  agentsList: [],
  isInstructLoading: false,
  instructResult: null,
});

function initialize() {
  model.init();
}

function getAgentsData() {
  const { call, abort } = agentService.getAgents();

  return {
    call: () => {
      model.setState({ isAgentsDataLoading: true });
      call().then((data: any) => {
        model.setState({ agentsList: data || [], isAgentsDataLoading: false });
      });
    },
    abort,
  };
}

function instructAgent(
  runHash: string,
  body: { type: string; payload: string; timeout?: number },
) {
  const { call, abort } = agentService.instructAgent(runHash, body);

  return {
    call: () => {
      model.setState({ isInstructLoading: true, instructResult: null });
      call()
        .then((data: any) => {
          model.setState({ isInstructLoading: false, instructResult: data });
        })
        .catch((err: any) => {
          model.setState({
            isInstructLoading: false,
            instructResult: { status: 'failed', error: String(err) },
          });
        });
    },
    abort,
  };
}

const agentAppModel = {
  ...model,
  initialize,
  getAgentsData,
  instructAgent,
};

export default agentAppModel;
