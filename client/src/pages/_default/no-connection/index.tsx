import Page from '~components/root/page';
import Section from '~components/root/section';

export default function NoConnection() {
	return (
		<Page heading='Server Connection Offline'>
			<Section>
				<p>
					The Web UI cannot connect to the server. Check that the server is running and
					reachable. It will reconnect automatically.
				</p>
			</Section>
		</Page>
	);
}
