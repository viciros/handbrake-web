#!/usr/bin/env bash
set -euo pipefail

: "${GH_TOKEN:?GH_TOKEN must be set}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY must be set}"
: "${PACKAGE_NAMES:?PACKAGE_NAMES must be set}"
: "${TAG_REGEX:?TAG_REGEX must be set}"
: "${MAX_AGE_SECONDS:?MAX_AGE_SECONDS must be set}"

OWNER="${OWNER:-${GITHUB_REPOSITORY_OWNER:-}}"
if [[ -z "$OWNER" ]]; then
	echo "OWNER or GITHUB_REPOSITORY_OWNER must be set."
	exit 1
fi

owner_type="$(gh api "/repos/${GITHUB_REPOSITORY}" --jq '.owner.type')"
case "$owner_type" in
	Organization)
		package_bases=("/orgs/${OWNER}/packages/container")
		;;
	User)
		package_bases=("/users/${OWNER}/packages/container" "/user/packages/container")
		;;
	*)
		echo "Unsupported GitHub owner type '${owner_type}' for '${OWNER}'."
		exit 1
		;;
esac

cutoff_epoch="$(date -u -d "${MAX_AGE_SECONDS} seconds ago" +%s)"
echo "Deleting GHCR package versions for owner '${OWNER}' with only tags matching '${TAG_REGEX}' updated before ${cutoff_epoch}."

for package in ${PACKAGE_NAMES}; do
	encoded_package="$(jq -nr --arg value "$package" '$value | @uri')"
	error_file="$(mktemp)"
	versions_endpoint=""
	versions_json=""

	echo "Checking package '${package}'."
	for package_base in "${package_bases[@]}"; do
		versions_endpoint="${package_base}/${encoded_package}/versions"
		if versions_json="$(gh api --paginate --slurp "${versions_endpoint}?per_page=100" 2>"$error_file")"; then
			break
		fi
	done

	if [[ -z "$versions_json" ]]; then
		echo "Skipping '${package}' because package versions could not be listed:"
		cat "$error_file"
		rm -f "$error_file"
		continue
	fi
	rm -f "$error_file"

	deletions="$(
		printf '%s' "$versions_json" |
			jq -r \
				--arg tag_regex "$TAG_REGEX" \
				--argjson cutoff_epoch "$cutoff_epoch" \
				'
				.[][]
				| {
					id,
					updated_at,
					tags: (.metadata.container.tags // [])
				}
				| select((.tags | length) > 0)
				| select((.updated_at | fromdateiso8601) <= $cutoff_epoch)
				| select((.tags | map(test($tag_regex)) | any) == true)
				| select((.tags | map(test($tag_regex)) | all) == true)
				| [.id, .updated_at, (.tags | join(","))]
				| @tsv
				'
	)"

	if [[ -z "$deletions" ]]; then
		echo "No package versions to delete for '${package}'."
		continue
	fi

	while IFS=$'\t' read -r version_id updated_at tags; do
		[[ -z "$version_id" ]] && continue

		echo "Deleting '${package}' version '${version_id}' updated '${updated_at}' with tags '${tags}'."
		gh api --method DELETE "${versions_endpoint}/${version_id}"
	done <<< "$deletions"
done
