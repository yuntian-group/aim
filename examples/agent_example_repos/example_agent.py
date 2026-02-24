import asyncio

from aim.sdk.agent.research_agent import AimResearchAgent
from aim.sdk.run import Run


def main():
    run = Run(repo='/Users/kstarxin/Documents/test_aim/.aim')
    agent = AimResearchAgent(run=run, repo_path='/Users/kstarxin/Documents/aim/examples/agent_example_repos/mock')
    asyncio.run(agent.start())


if __name__ == '__main__':
    main()
