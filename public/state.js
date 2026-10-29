// Shared dashboard selection and request state. No DOM or network side effects.
export const state = {
  report: null,
  history: [],
  comparison: null,
  comparisonFilter: "all",
  comparisonSelectedKey: null,
  comparisonRequestId: 0,
  reportRequestId: 0,
  selectedIssueId: null,
  selectedPage: null,
  selectedGraphNode: null,
  jobTimer: null,
  lastJob: null
};
