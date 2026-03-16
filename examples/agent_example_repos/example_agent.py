import asyncio

from aim.sdk.agent.research_agent import AimResearchAgent
from aim.sdk.run import Run


def main():
    run = Run(repo='/home/xuanhe_linux_001/.aim')
    agent = AimResearchAgent(
        run=run,
        repo_path='/home/xuanhe_linux_001/aim_frontend_experiment3/aim/examples/agent_example_repos/CelebFaces_Attributes_Classification',
    )
    asyncio.run(agent.start())


if __name__ == '__main__':
    main()
