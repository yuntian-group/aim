import API from '../api';

const endpoints = {
  GET_AGENTS: 'agent',
  INSTRUCT: (runHash: string) => `agent/${runHash}/instruct`,
  SAVED_PROBE_IDEAS: 'agent/saved/probe_ideas',
  SAVED_DEV_DOCS: 'agent/saved/dev_docs',
  PATCH_PROBE_IDEA: (probeId: string) => `agent/saved/probe_ideas/${probeId}`,
  PATCH_DEV_DOC: (docId: string) => `agent/saved/dev_docs/${docId}`,
};

function getAgents() {
  return API.get(endpoints.GET_AGENTS);
}

function instructAgent(runHash: string, body: object) {
  return API.post(endpoints.INSTRUCT(runHash), body, {
    headers: {
      'Content-Type': 'application/json',
    },
  });
}

function getSavedProbeIdeas() {
  return API.get(endpoints.SAVED_PROBE_IDEAS);
}

function saveProbeIdeasFull(items: any[]) {
  return API.post(
    endpoints.SAVED_PROBE_IDEAS,
    { PROBE_IDEA: items },
    {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );
}

function patchProbeIdea(probeId: string, patch: any) {
  return API.patch(
    endpoints.PATCH_PROBE_IDEA(probeId),
    { patch },
    {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );
}

function getSavedDevDocs() {
  return API.get(endpoints.SAVED_DEV_DOCS);
}

function saveDevDocsFull(items: any[]) {
  return API.post(
    endpoints.SAVED_DEV_DOCS,
    { DEV_DOC: items },
    {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );
}

function patchDevDoc(docId: string, patch: any) {
  return API.patch(
    endpoints.PATCH_DEV_DOC(docId),
    { patch },
    {
      headers: {
        'Content-Type': 'application/json',
      },
    },
  );
}

const agentService = {
  endpoints,
  getAgents,
  instructAgent,
  getSavedProbeIdeas,
  saveProbeIdeasFull,
  patchProbeIdea,
  getSavedDevDocs,
  saveDevDocsFull,
  patchDevDoc,
};

export default agentService;
