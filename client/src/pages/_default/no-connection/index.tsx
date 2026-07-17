import Section from '~components/root/section';

export default function NoConnection() {
	return (
		<Section heading='Server Connection Offline'>
			<p>
				The Web UI cannot connect to the server. Check that the server is running and
				reachable. It will reconnect automatically.
			</p>
		</Section>
	);
}
