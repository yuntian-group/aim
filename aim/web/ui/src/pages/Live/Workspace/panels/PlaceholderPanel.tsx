import React from 'react';

interface IPlaceholderPanelProps {
  title: string;
  hint: string;
}

function PlaceholderPanel({
  title,
  hint,
}: IPlaceholderPanelProps): React.FunctionComponentElement<React.ReactNode> {
  return (
    <div className='LivePanel'>
      <h3 className='LivePanel__title'>{title}</h3>
      <p className='LivePanel__hint'>{hint}</p>
    </div>
  );
}

export default PlaceholderPanel;
