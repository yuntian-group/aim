import React from 'react';

import ErrorBoundary from 'components/ErrorBoundary/ErrorBoundary';

import Live from './Live';

function LiveContainer(): React.FunctionComponentElement<React.ReactNode> {
  return (
    <ErrorBoundary>
      <Live />
    </ErrorBoundary>
  );
}

export default LiveContainer;
